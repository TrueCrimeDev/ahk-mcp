import { afterEach, describe, expect, it } from '@jest/globals';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import {
  definePrompt,
  registerPrompts,
  type PromptArguments,
} from '../../../src/tooling/prompt-spec.js';
import {
  defineResource,
  defineResourceTemplate,
  registerResources,
  type TemplateVariableNames,
} from '../../../src/tooling/resource-spec.js';
import {
  LEGACY,
  MODERN,
  connectStdio,
  envelope,
  initializeLegacy,
  type RpcClient,
  type RpcResponse,
} from './sdk-harness.js';

// Compile-time checks (Tests/setup/tsconfig.tests.json type-checks this file).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const variablesAreTyped: Equals<
  TemplateVariableNames<'ahk://docs/{kind}/{name}{?q,limit:3}'>,
  'kind' | 'name' | 'q' | 'limit'
> = true;

const DOCS: Record<string, string[]> = {
  function: ['WinGetList', 'WinActivate', 'StrReplace'],
  class: ['Map', 'Array'],
};

const docsIndex = defineResource({
  name: 'docs-index',
  uri: 'ahk://docs/index',
  title: 'Docs index',
  description: 'Names grouped by kind.',
  mimeType: 'application/json',
  annotations: { audience: ['assistant'], priority: 0.5 },
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  read: () => JSON.stringify(DOCS),
});

const guidesIndex = defineResource({
  name: 'guides-index',
  uri: 'ahk://guides/index',
  title: 'Guides',
  description: 'Guide topics.',
  mimeType: 'text/markdown',
  read: () => ({ text: '# Guides' }),
});

const vanished = defineResource({
  name: 'vanished',
  uri: 'ahk://server/vanished',
  title: 'Vanished',
  description: 'Always missing.',
  mimeType: 'text/plain',
  read: () => undefined,
});

const docsEntry = defineResourceTemplate({
  name: 'docs-entry',
  uriTemplate: 'ahk://docs/{kind}/{name}',
  title: 'Reference entry',
  description: 'One reference entry.',
  mimeType: 'text/markdown',
  list: () => [
    { uri: 'ahk://docs/function/WinGetList', name: 'WinGetList' },
    { uri: 'ahk://docs/class/Map', name: 'Map' },
  ],
  complete: {
    kind: value => Object.keys(DOCS).filter(kind => kind.startsWith(value)),
    name: (value, context) =>
      (DOCS[context?.arguments?.kind ?? ''] ?? []).filter(name => name.startsWith(value)),
  },
  read: (_uri, { kind, name }) =>
    DOCS[kind]?.includes(name) ? `# ${name}\n\nA ${kind}.` : undefined,
});

const review = definePrompt({
  name: 'ahk-review',
  title: 'Review a script',
  description: 'Review an AutoHotkey v2 script.',
  arguments: {
    path: {
      description: 'Script path inside the allowed roots.',
      required: true,
      complete: value =>
        ['C:/work/a.ahk', 'C:/work/b.ahk', 'C:/work/a.ahk'].filter(p => p.startsWith(value)),
    },
    focus: {
      description: 'What to look at.',
      enum: ['correctness', 'style', 'performance', 'v2-migration'],
    },
  },
  render: args => {
    // Types come from the declaration: path is required, focus is an optional enum.
    const typed: Equals<typeof args, PromptArguments<typeof review.arguments>> = true;
    const focus: 'correctness' | 'style' | 'performance' | 'v2-migration' | undefined = args.focus;
    const path: string = args.path;
    void typed;
    return {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Review ${path} for ${focus ?? 'everything'}` },
        },
      ],
    };
  },
});

const debugError = definePrompt({
  name: 'ahk-debug-error',
  title: 'Debug an error',
  description: 'Diagnose an AutoHotkey error.',
  arguments: {
    error: { description: 'The error text.', required: true },
    path: { description: 'Script path.' },
  },
  render: ({ error, path }) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `${error} in ${path ?? '(no path)'}` } },
    ],
  }),
});

const hello = definePrompt({
  name: 'ahk-hello',
  title: 'Hello',
  description: 'A prompt without arguments.',
  render: () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] }),
});

/**
 * Resources and prompts through McpServer, and a custom tools/list and
 * tools/call on the same underlying Server: the arrangement the v3 registry
 * uses. McpServer gets no tools capability, so it installs no tools handlers.
 */
function buildServer(): McpServer {
  const mcp = new McpServer(
    { name: 'spec-test', version: '0.0.0' },
    { capabilities: { resources: { subscribe: true, listChanged: true } } }
  );
  registerResources(mcp, [vanished, docsEntry, guidesIndex, docsIndex]);
  registerPrompts(mcp, [review, hello, debugError]);

  mcp.server.registerCapabilities({ tools: { listChanged: true } });
  mcp.server.setRequestHandler('tools/list', () => ({
    tools: [{ name: 'AHK_Echo', inputSchema: { type: 'object' as const } }],
  }));
  mcp.server.setRequestHandler('tools/call', (request, _ctx: ServerContext) => ({
    content: [{ type: 'text' as const, text: `echo ${request.params.name}` }],
  }));
  return mcp;
}

type Era = typeof LEGACY | typeof MODERN;

async function open(era: Era): Promise<{
  client: RpcClient;
  call: (method: string, params?: Record<string, unknown>) => Promise<RpcResponse>;
}> {
  const client = await connectStdio(() => buildServer());
  if (era === LEGACY) await initializeLegacy(client);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    client.request(method, era === MODERN ? { ...params, _meta: envelope() } : params);
  return { client, call };
}

describe.each([LEGACY, MODERN] as const)('resource and prompt specs on %s', era => {
  let client: RpcClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('lists resources and templates deterministically, with full metadata', async () => {
    const session = await open(era);
    client = session.client;
    const list = await session.call('resources/list');
    expect(list.error).toBeUndefined();
    const resources = list.result?.resources as Array<Record<string, unknown>>;
    expect(resources.map(resource => resource.uri)).toEqual([
      'ahk://docs/index',
      'ahk://guides/index',
      'ahk://server/vanished',
      'ahk://docs/class/Map',
      'ahk://docs/function/WinGetList',
    ]);
    expect(resources[0]).toMatchObject({
      name: 'docs-index',
      title: 'Docs index',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.5 },
    });
    // Template metadata fills in the listed entries.
    expect(resources[3]).toMatchObject({
      name: 'Map',
      title: 'Reference entry',
      mimeType: 'text/markdown',
    });

    const templates = await session.call('resources/templates/list');
    expect(templates.result?.resourceTemplates).toEqual([
      expect.objectContaining({ name: 'docs-entry', uriTemplate: 'ahk://docs/{kind}/{name}' }),
    ]);
  });

  it('reads static and templated resources with canonical URIs', async () => {
    const session = await open(era);
    client = session.client;
    const index = await session.call('resources/read', { uri: 'ahk://docs/index' });
    expect(index.result?.contents).toEqual([
      { uri: 'ahk://docs/index', mimeType: 'application/json', text: JSON.stringify(DOCS) },
    ]);
    if (era === MODERN) {
      expect(index.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: 'public' });
    } else {
      expect(index.result).not.toHaveProperty('ttlMs');
    }

    const entry = await session.call('resources/read', { uri: 'ahk://docs/class/Map' });
    expect(entry.result?.contents).toEqual([
      { uri: 'ahk://docs/class/Map', mimeType: 'text/markdown', text: '# Map\n\nA class.' },
    ]);
    const guides = await session.call('resources/read', { uri: 'ahk://guides/index' });
    expect(guides.result?.contents).toEqual([
      { uri: 'ahk://guides/index', mimeType: 'text/markdown', text: '# Guides' },
    ]);
  });

  it('answers unknown resources with -32602 and data.uri', async () => {
    const session = await open(era);
    client = session.client;
    for (const uri of [
      'ahk://docs/function/Nope',
      'ahk://nowhere/at-all',
      'ahk://server/vanished',
      'x:ahk://docs/index',
    ]) {
      const miss = await session.call('resources/read', { uri });
      expect(miss.error).toMatchObject({ code: -32602, data: { uri } });
    }
  });

  it('completes template variables, and rejects unknown template refs', async () => {
    const session = await open(era);
    client = session.client;
    const ref = { type: 'ref/resource', uri: 'ahk://docs/{kind}/{name}' };
    const kind = await session.call('completion/complete', {
      ref,
      argument: { name: 'kind', value: 'f' },
    });
    expect(kind.result?.completion).toMatchObject({ values: ['function'] });
    const name = await session.call('completion/complete', {
      ref,
      argument: { name: 'name', value: 'Win' },
      context: { arguments: { kind: 'function' } },
    });
    expect(name.result?.completion).toMatchObject({ values: ['WinGetList', 'WinActivate'] });
    const undeclared = await session.call('completion/complete', {
      ref,
      argument: { name: 'other', value: '' },
    });
    expect(undeclared.result?.completion).toMatchObject({ values: [] });
    const unknown = await session.call('completion/complete', {
      ref: { type: 'ref/resource', uri: 'ahk://nope/{x}' },
      argument: { name: 'x', value: '' },
    });
    expect(unknown.error?.code).toBe(-32602);
  });

  it('lists prompts sorted by name with typed arguments', async () => {
    const session = await open(era);
    client = session.client;
    const list = await session.call('prompts/list');
    const prompts = list.result?.prompts as Array<Record<string, unknown>>;
    expect(prompts.map(prompt => prompt.name)).toEqual([
      'ahk-debug-error',
      'ahk-hello',
      'ahk-review',
    ]);
    expect(prompts[2]).toMatchObject({
      title: 'Review a script',
      arguments: [
        { name: 'path', required: true, description: 'Script path inside the allowed roots.' },
        { name: 'focus', required: false, description: 'What to look at.' },
      ],
    });
    expect(prompts[1].arguments).toEqual([]);
  });

  it('renders prompts and rejects bad requests with -32602', async () => {
    const session = await open(era);
    client = session.client;
    const text = (response: RpcResponse) =>
      ((response.result?.messages as Array<{ content: { text: string } }>) ?? [])[0]?.content.text;

    expect(
      text(
        await session.call('prompts/get', {
          name: 'ahk-review',
          arguments: { path: 'a.ahk', focus: 'style' },
        })
      )
    ).toBe('Review a.ahk for style');
    expect(text(await session.call('prompts/get', { name: 'ahk-hello' }))).toBe('hello');
    // An empty optional argument counts as absent.
    expect(
      text(
        await session.call('prompts/get', {
          name: 'ahk-debug-error',
          arguments: { error: 'E', path: '' },
        })
      )
    ).toBe('E in (no path)');

    for (const params of [
      { name: 'ahk-missing' },
      { name: 'ahk-review' },
      { name: 'ahk-review', arguments: { focus: 'style' } },
      { name: 'ahk-review', arguments: { path: '' } },
      { name: 'ahk-review', arguments: { path: 'a.ahk', focus: 'bogus' } },
    ]) {
      const response = await session.call('prompts/get', params);
      expect(response.error?.code).toBe(-32602);
    }
  });

  it('completes declared prompt arguments only', async () => {
    const session = await open(era);
    client = session.client;
    const complete = (name: string, argument: string, value: string) =>
      session.call('completion/complete', {
        ref: { type: 'ref/prompt', name },
        argument: { name: argument, value },
      });

    expect((await complete('ahk-review', 'focus', 'ST')).result?.completion).toMatchObject({
      values: ['style'],
    });
    expect((await complete('ahk-review', 'path', 'C:/work/a')).result?.completion).toMatchObject({
      values: ['C:/work/a.ahk'],
    });
    expect((await complete('ahk-review', 'undeclared', '')).result?.completion).toMatchObject({
      values: [],
    });
    expect((await complete('ahk-nope', 'path', '')).error?.code).toBe(-32602);
  });

  it('serves the custom tools handlers from the same server', async () => {
    const session = await open(era);
    client = session.client;
    const tools = await session.call('tools/list');
    expect(tools.result?.tools).toEqual([expect.objectContaining({ name: 'AHK_Echo' })]);
    const result = await session.call('tools/call', { name: 'AHK_Echo', arguments: {} });
    expect(result.result?.content).toEqual([{ type: 'text', text: 'echo AHK_Echo' }]);
  });
});

describe('spec validation', () => {
  const base = { title: 'T', description: 'D', mimeType: 'text/plain', read: () => 'x' };

  it('rejects non-canonical URIs and bad metadata at definition time', () => {
    expect(() => defineResource({ ...base, name: 'upper', uri: 'AHK://docs/index' })).toThrow(
      /canonical/
    );
    expect(() => defineResource({ ...base, name: 'bad uri', uri: 'ahk://x' })).toThrow(/slug/);
    expect(() => defineResource({ ...base, name: 'rel', uri: 'relative/path' })).toThrow(
      /valid URI/
    );
    expect(() =>
      defineResource({ ...base, name: 'ttl', uri: 'ahk://x', cacheHint: { ttlMs: -1 } })
    ).toThrow(RangeError);
    expect(() => defineResource({ ...base, name: 'no-title', title: ' ', uri: 'ahk://x' })).toThrow(
      /title/
    );
  });

  it('rejects unusable templates', () => {
    const template = { ...base, list: undefined, read: () => 'x' };
    expect(() =>
      defineResourceTemplate({ ...template, name: 'explode', uriTemplate: 'ahk://x/{path*}' })
    ).toThrow(/explode/);
    expect(() =>
      defineResourceTemplate({ ...template, name: 'none', uriTemplate: 'ahk://x/y' })
    ).toThrow(/no variables/);
    expect(() =>
      defineResourceTemplate({
        ...template,
        name: 'stray',
        uriTemplate: 'ahk://x/{id}',
        complete: { other: () => [] } as never,
      })
    ).toThrow(/names no template variable/);
  });

  it('rejects duplicate registrations and bad prompt declarations', () => {
    const server = new McpServer({ name: 'dup', version: '0.0.0' });
    const one = defineResource({ ...base, name: 'same', uri: 'ahk://one' });
    const two = defineResource({ ...base, name: 'same', uri: 'ahk://two' });
    expect(() => registerResources(server, [one, two])).toThrow(/Duplicate resource name/);
    expect(() => registerPrompts(server, [hello, hello])).toThrow(/Duplicate prompt name/);
    expect(() =>
      definePrompt({
        name: 'bad',
        title: 'T',
        description: 'D',
        arguments: { 'not-ident': { description: 'x' } },
        render: () => ({ messages: [] }),
      })
    ).toThrow(/identifier/);
    expect(() =>
      definePrompt({
        name: 'bad',
        title: 'T',
        description: 'D',
        arguments: { a: { description: '' } },
        render: () => ({ messages: [] }),
      })
    ).toThrow(/description/);
    expect(variablesAreTyped).toBe(true);
  });
});
