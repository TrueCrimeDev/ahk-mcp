import { describe, expect, it } from '@jest/globals';
import express from 'express';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  StudioServiceError,
  type StudioService,
  type StudioServiceErrorCode,
} from '../../src/studio/studio-service.js';
import { mountStudio } from '../../src/studio/studio-http.js';

const previewId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const macro = {
  id: 'show_desktop_message',
  title: 'Show desktop message',
  description: 'Displays a local desktop message.',
  effect: 'Opens one local message window.',
  targets: ['desktop'],
  inputSchema: { type: 'object' },
};
const preview = {
  previewId,
  macro,
  parameters: { message: 'Hi' },
  scriptHash: 'a'.repeat(64),
  createdAt: '2026-08-27T12:00:00.000Z',
  expiresAt: '2026-08-27T12:05:00.000Z',
};
const run = {
  runId,
  macro,
  parameters: { message: 'Hi' },
  scriptHash: 'a'.repeat(64),
  createdAt: '2026-08-27T12:00:00.000Z',
  expiresAt: '2026-08-27T12:05:00.000Z',
  state: 'pending_approval' as const,
  result: null,
};

type HttpStudioService = Pick<
  StudioService,
  'listMacros' | 'createPreview' | 'requestRun' | 'getRun' | 'approveRun'
>;

function createHttpTestService(overrides: Partial<HttpStudioService> = {}): HttpStudioService {
  return {
    listMacros: () => ({
      macros: [macro],
      runtime: { available: true, version: '2.0.19', sha256: 'b'.repeat(64) },
    }),
    createPreview: async () => preview,
    requestRun: () => run,
    getRun: () => run,
    approveRun: async () => ({ ...run, state: 'succeeded', result: null }),
    ...overrides,
  };
}

async function startStudioHttpFixture(service: HttpStudioService = createHttpTestService()) {
  const app = express();
  app.use(express.json());
  mountStudio(app, service);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      ),
  };
}

function mutationHeaders(port: number, overrides: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    origin: `http://127.0.0.1:${port}`,
    ...overrides,
  };
}

interface StudioHttpTestResponse {
  status: number;
  headers: Headers;
  json(): Record<string, unknown>;
}

async function postStudioWithAuthority(
  fixture: { port: number },
  path: string,
  body: string,
  authority: { host?: string; origin?: string }
): Promise<StudioHttpTestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      host: authority.host ?? `127.0.0.1:${fixture.port}`,
    };
    if (authority.origin) headers.origin = authority.origin;
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: fixture.port,
        path,
        method: 'POST',
        headers,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) responseHeaders.set(name, String(value));
          }
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders,
            json: () => JSON.parse(responseBody) as Record<string, unknown>,
          });
        });
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

function expectStudioHeaders(response: { headers: { get(name: string): string | null } }): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
}

describe('Studio HTTP surface', () => {
  it('serves the external-only page and classic assets with security headers', async () => {
    const fixture = await startStudioHttpFixture();
    try {
      for (const path of ['/studio', '/studio/styles.css', '/studio/app.js', '/studio/webmcp.js']) {
        const response = await fetch(fixture.url + path);
        expect(response.status).toBe(200);
        expectStudioHeaders(response);
        const body = await response.text();
        expect(body.length).toBeGreaterThan(20);
        if (path === '/studio') {
          expect(body).toContain('AHK Macro Studio');
          expect(body).toContain('<script src="/studio/app.js" defer></script>');
          expect(body).toContain('<script src="/studio/webmcp.js" defer></script>');
          expect(body).not.toMatch(/<script(?![^>]+src=)[^>]*>/i);
          expect(body).not.toMatch(/\s(?:style|on\w+)=/i);
        }
      }
    } finally {
      await fixture.close();
    }
  });

  it('serves all five JSON route shapes and protects API responses', async () => {
    const fixture = await startStudioHttpFixture();
    try {
      const requests: Array<[string, RequestInit | undefined, number, Record<string, unknown>]> = [
        ['/studio/api/macros', undefined, 200, { macros: [macro] }],
        [
          '/studio/api/previews',
          {
            method: 'POST',
            headers: mutationHeaders(fixture.port),
            body: JSON.stringify({ macroId: macro.id, parameters: { message: 'Hi' } }),
          },
          201,
          { previewId },
        ],
        [
          '/studio/api/runs',
          {
            method: 'POST',
            headers: mutationHeaders(fixture.port),
            body: JSON.stringify({ previewId }),
          },
          201,
          { runId, state: 'pending_approval' },
        ],
        [`/studio/api/runs/${runId}`, undefined, 200, { runId }],
        [
          `/studio/api/runs/${runId}/approve`,
          { method: 'POST', headers: mutationHeaders(fixture.port), body: '{}' },
          200,
          { runId, state: 'succeeded' },
        ],
      ];

      for (const [path, init, status, expected] of requests) {
        const response = await fetch(fixture.url + path, init);
        expect(response.status).toBe(status);
        expectStudioHeaders(response);
        expect(await response.json()).toMatchObject(expected);
      }
    } finally {
      await fixture.close();
    }
  });

  it('rejects every Studio POST unless Host and Origin are the same HTTP loopback authority', async () => {
    let calls = 0;
    const service = createHttpTestService({
      createPreview: async () => {
        calls += 1;
        return preview;
      },
      requestRun: () => {
        calls += 1;
        return run;
      },
      approveRun: async () => {
        calls += 1;
        return run;
      },
    });
    const fixture = await startStudioHttpFixture(service);
    const cases: Array<{ host?: string; origin?: string }> = [
      {},
      { origin: `https://127.0.0.1:${fixture.port}` },
      { origin: `http://localhost:${fixture.port}` },
      { origin: 'https://viols.dev' },
      { origin: `http://127.0.0.1:${fixture.port + 1}` },
      { origin: 'not an origin' },
      { origin: `http://127.0.0.1:${fixture.port}/path` },
      { host: `example.com:${fixture.port}`, origin: `http://example.com:${fixture.port}` },
      { host: 'not a host', origin: 'http://not a host' },
      {
        host: `127.1:${fixture.port}`,
        origin: `http://127.0.0.1:${fixture.port}`,
      },
      {
        host: `2130706433:${fixture.port}`,
        origin: `http://127.0.0.1:${fixture.port}`,
      },
      {
        host: `[0:0:0:0:0:0:0:1]:${fixture.port}`,
        origin: `http://[::1]:${fixture.port}`,
      },
    ];
    const posts = [
      ['/studio/api/previews', { macroId: macro.id, parameters: { message: 'Hi' } }],
      ['/studio/api/runs', { previewId }],
      [`/studio/api/runs/${runId}/approve`, {}],
      ['/studio/missing', {}],
    ] as const;

    try {
      for (const post of posts) {
        for (const testCase of cases) {
          const response = await postStudioWithAuthority(
            fixture,
            post[0],
            JSON.stringify(post[1]),
            testCase
          );
          expect(response.status).toBe(403);
          expectStudioHeaders(response);
          expect(await response.json()).toEqual({
            code: 'loopback_required',
            message: 'Studio changes require the local page.',
          });
        }
      }
      expect(calls).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('accepts exact localhost, IPv4, and IPv6 loopback authorities', async () => {
    const fixture = await startStudioHttpFixture();
    try {
      for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
        const host = `${hostname}:${fixture.port}`;
        const response = await postStudioWithAuthority(
          fixture,
          '/studio/api/previews',
          JSON.stringify({ macroId: macro.id, parameters: { message: 'Hi' } }),
          { host, origin: `http://${host}` }
        );
        expect(response.status).toBe(201);
        expectStudioHeaders(response);
        expect(await response.json()).toMatchObject({ previewId });
      }
    } finally {
      await fixture.close();
    }
  });

  it('sanitizes malformed JSON rejected before Studio middleware using the Host and Origin boundary', async () => {
    const fixture = await startStudioHttpFixture();
    try {
      const validHost = `localhost:${fixture.port}`;
      const malformed = await postStudioWithAuthority(fixture, '/studio/api/previews', '{', {
        host: validHost,
        origin: `http://${validHost}`,
      });
      expect(malformed.status).toBe(400);
      expectStudioHeaders(malformed);
      expect(await malformed.json()).toEqual({
        code: 'invalid_input',
        message: 'Studio input is invalid.',
      });

      const invalidAuthorities = [
        {
          host: `127.1:${fixture.port}`,
          origin: `http://127.0.0.1:${fixture.port}`,
        },
        {
          host: `127.0.0.1:${fixture.port}`,
          origin: `https://127.0.0.1:${fixture.port}`,
        },
        { host: `127.0.0.1:${fixture.port}`, origin: undefined },
      ];
      for (const authority of invalidAuthorities) {
        const response = await postStudioWithAuthority(
          fixture,
          '/studio/api/previews',
          '{',
          authority
        );
        expect(response.status).toBe(403);
        expectStudioHeaders(response);
        expect(await response.json()).toEqual({
          code: 'loopback_required',
          message: 'Studio changes require the local page.',
        });
      }
    } finally {
      await fixture.close();
    }
  });

  const serviceErrorCases: Array<
    [StudioServiceErrorCode, 400 | 404 | 409 | 410 | 500 | 503, string]
  > = [
    ['invalid_input', 400, 'Studio input is invalid.'],
    ['macro_not_found', 404, 'Macro was not found.'],
    ['state_conflict', 409, 'The requested state transition is not allowed.'],
    ['preview_expired', 410, 'Preview has expired.'],
    ['integrity_failed', 500, 'Studio execution integrity check failed.'],
    ['execution_unavailable', 503, 'Native execution is unavailable.'],
  ];

  it.each(serviceErrorCases)(
    'maps only the fixed %s service error fields to HTTP %i',
    async (code, status, message) => {
      const fixture = await startStudioHttpFixture(
        createHttpTestService({
          createPreview: async () => {
            throw new StudioServiceError(code, status);
          },
        })
      );
      try {
        const response = await fetch(fixture.url + '/studio/api/previews', {
          method: 'POST',
          headers: mutationHeaders(fixture.port),
          body: JSON.stringify({ macroId: macro.id, parameters: { message: 'Hi' } }),
        });
        expect(response.status).toBe(status);
        expectStudioHeaders(response);
        expect(await response.json()).toEqual({ code, message });
      } finally {
        await fixture.close();
      }
    }
  );

  it('sanitizes unknown errors and protects unmatched Studio responses', async () => {
    const fixture = await startStudioHttpFixture(
      createHttpTestService({
        listMacros: () => {
          throw new Error('C:\\private\\macro.ahk stack secret');
        },
      })
    );
    try {
      const failed = await fetch(fixture.url + '/studio/api/macros');
      expect(failed.status).toBe(500);
      expectStudioHeaders(failed);
      expect(await failed.json()).toEqual({
        code: 'internal_error',
        message: 'Studio request failed.',
      });

      const missing = await fetch(fixture.url + '/studio/missing');
      expect(missing.status).toBe(404);
      expectStudioHeaders(missing);
      expect(await missing.json()).toEqual({
        code: 'not_found',
        message: 'Studio resource was not found.',
      });
    } finally {
      await fixture.close();
    }
  });
});
