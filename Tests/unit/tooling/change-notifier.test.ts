import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Server, createMcpHandler, type ServerEvent } from '@modelcontextprotocol/server';
import {
  ChangeNotifier,
  contentHash,
  type ChangeSink,
  type FileTouchedEvent,
} from '../../../src/server/change-notifier.js';
import {
  connectStdio,
  envelope,
  initializeLegacy,
  settle,
  type RpcClient,
  type RpcNotification,
} from './sdk-harness.js';

const RECENT = 'ahk://workspace/recent';
const STATUS = 'ahk://server/status';

function fakeSink() {
  return {
    toolsChanged: jest.fn<() => void>(),
    promptsChanged: jest.fn<() => void>(),
    resourcesChanged: jest.fn<() => void>(),
    resourceUpdated: jest.fn<(uri: string) => void>(),
  } satisfies ChangeSink;
}

function subscribableServer(
  notifier: ChangeNotifier,
  options: { legacySubscriptions?: boolean } = {}
) {
  const server = new Server(
    { name: 'notifier-test', version: '0.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
    }
  );
  // Minimal handlers so the capabilities are honest.
  server.setRequestHandler('tools/list', () => ({ tools: [] }));
  server.setRequestHandler('resources/list', () => ({ resources: [] }));
  notifier.addServer(server, options);
  return server;
}

const isUpdated = (uri: string) => (n: RpcNotification) =>
  n.method === 'notifications/resources/updated' && n.params?.uri === uri;

describe('ChangeNotifier dedupe', () => {
  it('sends resourceUpdated only when the content hash changes', () => {
    const notifier = new ChangeNotifier();
    const sink = fakeSink();
    notifier.addSink(sink);

    expect(notifier.resourceUpdated(RECENT, ['a.ahk'])).toBe(true);
    expect(notifier.resourceUpdated(RECENT, ['a.ahk'])).toBe(false);
    expect(notifier.resourceUpdated(RECENT, ['b.ahk', 'a.ahk'])).toBe(true);
    // Hashes are per URI.
    expect(notifier.resourceUpdated(STATUS, ['b.ahk', 'a.ahk'])).toBe(true);

    expect(sink.resourceUpdated.mock.calls).toEqual([[RECENT], [RECENT], [STATUS]]);
  });

  it('hashes JSON content independently of key order, and text and bytes by value', () => {
    expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash(new TextEncoder().encode('abc')));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('primes a baseline without notifying, and forgets on request', () => {
    const notifier = new ChangeNotifier();
    const sink = fakeSink();
    notifier.addSink(sink);

    notifier.primeResource(RECENT, []);
    expect(notifier.resourceUpdated(RECENT, [])).toBe(false);
    notifier.forgetResource(RECENT);
    expect(notifier.resourceUpdated(RECENT, [])).toBe(true);
    expect(sink.resourceUpdated).toHaveBeenCalledTimes(1);
  });

  it('bounds the number of remembered hashes', () => {
    const notifier = new ChangeNotifier({ maxTrackedUris: 2 });
    const sink = fakeSink();
    notifier.addSink(sink);
    notifier.resourceUpdated('ahk://runs/1', 'x');
    notifier.resourceUpdated('ahk://runs/2', 'x');
    notifier.resourceUpdated('ahk://runs/3', 'x');
    // runs/1 was evicted, so the same content counts as new again.
    expect(notifier.resourceUpdated('ahk://runs/1', 'x')).toBe(true);
    expect(notifier.resourceUpdated('ahk://runs/3', 'x')).toBe(false);
  });

  it('ignores empty URIs and unhashable content instead of throwing', () => {
    const notifier = new ChangeNotifier();
    const sink = fakeSink();
    notifier.addSink(sink);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(notifier.resourceUpdated('', 'x')).toBe(false);
    expect(notifier.resourceUpdated(RECENT, cyclic)).toBe(false);
    expect(sink.resourceUpdated).not.toHaveBeenCalled();
  });
});

describe('ChangeNotifier fan-out', () => {
  let clients: RpcClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map(client => client.close()));
    clients = [];
  });

  it('never throws into the caller, and one failing sink does not stop the others', async () => {
    const notifier = new ChangeNotifier();
    const throwing: ChangeSink = {
      toolsChanged: () => {
        throw new Error('sync failure');
      },
      promptsChanged: () => Promise.reject(new Error('async failure')),
      resourcesChanged: () => undefined,
      resourceUpdated: () => Promise.reject(new Error('not connected')),
    };
    const healthy = fakeSink();
    notifier.addSink(throwing, 'broken');
    notifier.addSink(healthy, 'healthy');

    expect(() => notifier.toolsChanged()).not.toThrow();
    expect(() => notifier.promptsChanged()).not.toThrow();
    expect(() => notifier.resourceUpdated(RECENT, 1)).not.toThrow();
    await notifier.idle();

    expect(healthy.toolsChanged).toHaveBeenCalledTimes(1);
    expect(healthy.promptsChanged).toHaveBeenCalledTimes(1);
    expect(healthy.resourceUpdated).toHaveBeenCalledWith(RECENT);
  });

  it('reaches a 2026 stdio listen stream and the createMcpHandler notify bus, deduped', async () => {
    const notifier = new ChangeNotifier();

    const handler = createMcpHandler(() => subscribableServer(new ChangeNotifier()));
    const busEvents: ServerEvent[] = [];
    handler.bus.subscribe(event => busEvents.push(event));
    notifier.addSink(handler.notify, 'http');

    const client = await connectStdio(() => subscribableServer(notifier));
    clients.push(client);
    // Opens the connection on the modern era and subscribes to the resource.
    void client.request('subscriptions/listen', {
      notifications: { resourceSubscriptions: [RECENT], toolsListChanged: true },
      _meta: envelope(),
    });
    await client.waitForNotification(n => n.method === 'notifications/subscriptions/acknowledged');
    expect(notifier.sinkCount).toBe(2);

    expect(notifier.resourceUpdated(RECENT, { files: ['a.ahk'] })).toBe(true);
    await client.waitForNotification(isUpdated(RECENT));
    expect(busEvents).toEqual([{ kind: 'resource_updated', uri: RECENT }]);

    // Same content: nothing goes to either sink.
    expect(notifier.resourceUpdated(RECENT, { files: ['a.ahk'] })).toBe(false);
    notifier.toolsChanged();
    await client.waitForNotification(n => n.method === 'notifications/tools/list_changed');
    await notifier.idle();
    await settle();

    expect(client.notifications.filter(isUpdated(RECENT))).toHaveLength(1);
    expect(busEvents).toEqual([
      { kind: 'resource_updated', uri: RECENT },
      { kind: 'tools_list_changed' },
    ]);
    await handler.close();
  });

  it('on a 2025 stdio connection, sends resources/updated only for subscribed URIs', async () => {
    const notifier = new ChangeNotifier();
    const client = await connectStdio(() =>
      subscribableServer(notifier, { legacySubscriptions: true })
    );
    clients.push(client);
    await initializeLegacy(client);

    const subscribe = await client.request('resources/subscribe', { uri: RECENT });
    expect(subscribe.error).toBeUndefined();

    notifier.resourceUpdated(STATUS, 'not subscribed');
    notifier.resourceUpdated(RECENT, 'subscribed');
    await client.waitForNotification(isUpdated(RECENT));
    await notifier.idle();
    await settle();
    expect(client.notifications.filter(isUpdated(STATUS))).toHaveLength(0);

    await client.request('resources/unsubscribe', { uri: RECENT });
    notifier.resourceUpdated(RECENT, 'changed again');
    await notifier.idle();
    await settle();
    expect(client.notifications.filter(isUpdated(RECENT))).toHaveLength(1);
  });

  it('skips notifications the server does not advertise and drops closed servers', async () => {
    const notifier = new ChangeNotifier();
    const quiet = new Server({ name: 'quiet', version: '0.0.0' }, { capabilities: { tools: {} } });
    quiet.setRequestHandler('tools/list', () => ({ tools: [] }));
    const send = jest.spyOn(quiet, 'notification');
    notifier.addServer(quiet);

    const client = await connectStdio(() => quiet);
    clients.push(client);
    await initializeLegacy(client);

    notifier.toolsChanged(); // tools.listChanged not advertised
    notifier.resourceUpdated(RECENT, 'x'); // no resources capability
    await notifier.idle();
    expect(send).not.toHaveBeenCalled();

    expect(notifier.sinkCount).toBe(1);
    await client.close();
    clients = [];
    await settle();
    expect(notifier.sinkCount).toBe(0);
  });
});

describe('ChangeNotifier fileTouched', () => {
  it('emits events to every listener, isolating failures', () => {
    const notifier = new ChangeNotifier({ now: () => 42 });
    const seen: FileTouchedEvent[] = [];
    notifier.onFileTouched(() => {
      throw new Error('listener bug');
    });
    const unsubscribe = notifier.onFileTouched(event => seen.push(event));

    expect(() => notifier.fileTouched('C:/work/a.ahk', 'edited')).not.toThrow();
    notifier.fileTouched('C:/work/b.ahk', 'bogus' as never);
    notifier.fileTouched('', 'ran');
    unsubscribe();
    notifier.fileTouched('C:/work/c.ahk', 'ran');

    expect(seen).toEqual([{ path: 'C:/work/a.ahk', kind: 'edited', at: 42 }]);
  });
});
