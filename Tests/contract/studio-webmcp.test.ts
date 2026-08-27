import { describe, expect, it } from '@jest/globals';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import type { StudioService } from '../../src/studio/studio-service.js';
import { mountStudio } from '../../src/studio/studio-http.js';

interface ToolRegistration {
  name: string;
  description: string;
  annotations: { readOnlyHint: boolean };
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

const previewId = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serviceStub(): Pick<
  StudioService,
  'listMacros' | 'createPreview' | 'requestRun' | 'getRun' | 'approveRun'
> {
  const unexpected = (): never => {
    throw new Error('The WebMCP asset test must not invoke the server service.');
  };
  return {
    listMacros: unexpected,
    createPreview: unexpected,
    requestRun: unexpected,
    getRun: unexpected,
    approveRun: unexpected,
  };
}

async function getStudioAsset(assetPath: string): Promise<string> {
  const app = express();
  mountStudio(app, serviceStub());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${assetPath}`);
    expect(response.status).toBe(200);
    return await response.text();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
}

const getWebMcpAsset = () => getStudioAsset('/studio/webmcp.js');

class FakeCustomEvent {
  readonly type: string;
  readonly detail: unknown;

  constructor(type: string, init: { detail: unknown }) {
    this.type = type;
    this.detail = init.detail;
  }
}

class FakeElement {
  textContent = '';
  disabled = false;
  value = '';
  type = '';
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event?: FakeCustomEvent) => void>>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: (event?: FakeCustomEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'button' ? [...this.children] : [];
  }
}

describe('Studio WebMCP classic-script contract', () => {
  it('registers exactly four tools sequentially with strict schemas and plain JSON results', async () => {
    const source = await getWebMcpAsset();
    const registrations: ToolRegistration[] = [];
    const registrationOrder: string[] = [];
    const registrationGates = [
      deferred<void>(),
      deferred<void>(),
      deferred<void>(),
      deferred<void>(),
    ];
    const fetches: Array<{ input: string; init?: { method?: string; body?: string } }> = [];
    const events: FakeCustomEvent[] = [];
    const document = {
      modelContext: {
        registerTool(tool: ToolRegistration) {
          const gate = registrationGates[registrations.length];
          if (!gate) throw new Error('Unexpected extra WebMCP registration.');
          registrations.push(tool);
          return gate.promise.then(() => {
            registrationOrder.push(tool.name);
          });
        },
      },
      dispatchEvent(event: FakeCustomEvent) {
        events.push(event);
        return true;
      },
    };
    const context = vm.createContext({
      document,
      CustomEvent: FakeCustomEvent,
      fetch: async (input: string, init?: { method?: string; body?: string }) => {
        fetches.push({ input, init });
        return {
          ok: true,
          status: 201,
          json: async () => ({ runId: 'run-1', state: 'pending_approval' }),
        };
      },
    });

    new vm.Script(source, { filename: 'webmcp.js' }).runInContext(context);
    const ready = vm.runInContext('globalThis.__ahkStudioWebMcpReady', context) as Promise<void>;

    const expectedNames = [
      'list_ahk_macros',
      'preview_ahk_macro',
      'request_ahk_macro_run',
      'get_ahk_run_status',
    ];
    expect(registrations.map(tool => tool.name)).toEqual(expectedNames.slice(0, 1));
    for (let index = 0; index < registrationGates.length - 1; index += 1) {
      registrationGates[index]?.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(registrations.map(tool => tool.name)).toEqual(expectedNames.slice(0, index + 2));
    }
    registrationGates[3]?.resolve();
    await ready;

    expect(registrations.map(tool => [tool.name, tool.annotations])).toEqual([
      ['list_ahk_macros', { readOnlyHint: true }],
      ['preview_ahk_macro', { readOnlyHint: true }],
      ['request_ahk_macro_run', { readOnlyHint: false }],
      ['get_ahk_run_status', { readOnlyHint: true }],
    ]);
    expect(registrationOrder).toEqual(registrations.map(tool => tool.name));
    for (const registration of registrations) {
      expect(registration.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
    expect(registrations[1]?.inputSchema).toEqual({
      type: 'object',
      properties: {
        macroId: { type: 'string', enum: ['show_desktop_message'] },
        parameters: {
          type: 'object',
          properties: { message: { type: 'string', minLength: 1, maxLength: 120 } },
          required: ['message'],
          additionalProperties: false,
        },
      },
      required: ['macroId', 'parameters'],
      additionalProperties: false,
    });
    expect(registrations[2]?.inputSchema).toEqual({
      type: 'object',
      properties: { previewId: { type: 'string', format: 'uuid' } },
      required: ['previewId'],
      additionalProperties: false,
    });
    expect(registrations[3]?.inputSchema).toEqual({
      type: 'object',
      properties: { runId: { type: 'string', format: 'uuid' } },
      required: ['runId'],
      additionalProperties: false,
    });

    const result = await registrations[2]?.execute({ previewId });
    expect(result).toEqual({ runId: 'run-1', state: 'pending_approval' });
    expect(fetches).toEqual([
      {
        input: '/studio/api/runs',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ previewId }),
        },
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'ahk-studio-tool-result',
        detail: {
          tool: 'request_ahk_macro_run',
          result: { runId: 'run-1', state: 'pending_approval' },
        },
      }),
    ]);
    expect(source).not.toContain('/approve');
    for (const registration of registrations) {
      expect(String(registration.execute)).not.toContain('/approve');
    }
    expect(vm.runInContext('Object.keys(globalThis)', context)).not.toEqual(
      expect.arrayContaining(['list_ahk_macros', 'preview_ahk_macro', 'request_ahk_macro_run'])
    );
  });

  it('feature-detects unsupported WebMCP without registering or disrupting the document', async () => {
    const source = await getWebMcpAsset();
    let dispatched = false;
    const context = vm.createContext({
      document: {
        dispatchEvent() {
          dispatched = true;
        },
      },
      CustomEvent: FakeCustomEvent,
      fetch: async () => {
        throw new Error('Unsupported WebMCP must not fetch.');
      },
    });

    new vm.Script(source, { filename: 'webmcp.js' }).runInContext(context);
    await (vm.runInContext('globalThis.__ahkStudioWebMcpReady', context) as Promise<void>);

    expect(dispatched).toBe(false);
  });

  it('keeps fallback status and targets visible and disables a stale Stage action after WebMCP staging', async () => {
    const source = await getStudioAsset('/studio/app.js');
    const html = await getStudioAsset('/studio');
    const ids = [
      'macro-list',
      'selected-macro',
      'message',
      'preview-button',
      'stage-button',
      'status-button',
      'approve-button',
      'preview-panel',
      'run-panel',
      'studio-error',
      'local-status',
      'runtime-status',
      'webmcp-status',
    ];
    const elements = new Map(ids.map(id => [id, new FakeElement()]));
    const documentListeners = new Map<string, Array<(event: FakeCustomEvent) => void>>();
    const document = {
      getElementById(id: string) {
        return elements.get(id);
      },
      createElement() {
        return new FakeElement();
      },
      addEventListener(name: string, listener: (event: FakeCustomEvent) => void) {
        const listeners = documentListeners.get(name) ?? [];
        listeners.push(listener);
        documentListeners.set(name, listeners);
      },
    };
    const context = vm.createContext({
      document,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          runtime: {
            available: false,
            reason: 'disabled',
            message: 'Native execution is disabled.',
          },
          macros: [
            {
              id: 'show_desktop_message',
              title: 'Show desktop message',
              effect: 'Shows one dismissible message dialog on this PC.',
              targets: ['Windows desktop'],
            },
          ],
        }),
      }),
    });

    new vm.Script(source, { filename: 'app.js' }).runInContext(context);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(elements.get('local-status')?.textContent).toBe('Local companion: connected.');
    expect(elements.get('runtime-status')?.textContent).toBe(
      'Native runtime: Native execution is disabled.'
    );
    expect(elements.get('webmcp-status')?.textContent).toBe(
      'WebMCP: unavailable — use the page controls.'
    );
    expect(elements.get('macro-list')?.children[0]?.textContent).toContain('Windows desktop');
    expect(html).toContain('>Run on this PC</button>');

    const publish = (detail: unknown) => {
      for (const listener of documentListeners.get('ahk-studio-tool-result') ?? []) {
        listener(new FakeCustomEvent('ahk-studio-tool-result', { detail }));
      }
    };
    publish({
      tool: 'preview_ahk_macro',
      result: { previewId: 'preview-1', parameters: { message: 'Hello' } },
    });
    expect(elements.get('stage-button')?.disabled).toBe(false);
    publish({
      tool: 'request_ahk_macro_run',
      result: { runId: 'run-1', state: 'pending_approval' },
    });
    expect(elements.get('stage-button')?.disabled).toBe(true);
  });
});
