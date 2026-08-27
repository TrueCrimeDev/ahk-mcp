import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { createStudioMacroCatalog } from '../../src/studio/macro-catalog.js';

describe('Studio macro catalog', () => {
  const root = path.resolve(process.cwd(), 'scripts', 'studio');
  const catalog = createStudioMacroCatalog(root);

  it('publishes exactly the curated desktop-message macro', () => {
    expect(catalog.list()).toEqual([
      {
        id: 'show_desktop_message',
        title: 'Show desktop message',
        description: 'Display a short message in a native Windows dialog.',
        effect: 'Shows one dismissible message dialog on this PC.',
        targets: ['Windows desktop'],
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 120 },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    ]);
  });

  it.each(['', 'x'.repeat(121)])('rejects an out-of-range message', message => {
    const macro = catalog.get('show_desktop_message');
    expect(() => macro?.parameterSchema.parse({ message })).toThrow();
  });

  it('rejects unknown fields and builds one fixed argument', () => {
    const macro = catalog.get('show_desktop_message');
    expect(() => macro?.parameterSchema.parse({ message: 'Hello', path: 'C:\\x.ahk' })).toThrow();
    const parameters = macro?.parameterSchema.parse({ message: 'Hello' });
    expect(macro?.buildArguments(parameters ?? {})).toEqual(['Hello']);
    expect(macro?.timeoutMs).toBe(30_000);
  });
});
