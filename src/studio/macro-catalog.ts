import path from 'node:path';
import { z } from 'zod';
import type {
  StudioMacroCatalog,
  StudioMacroDefinition,
  StudioParameters,
} from './studio-types.js';

export function createStudioMacroCatalog(rootPath: string): StudioMacroCatalog {
  const messageSchema = z
    .object({ message: z.string().min(1).max(120) })
    .strict()
    .transform(value => value as StudioParameters);

  const definition: StudioMacroDefinition = {
    metadata: {
      id: 'show_desktop_message',
      title: 'Show desktop message',
      description: 'Display a short message in a native Windows dialog.',
      effect: 'Shows one dismissible message dialog on this PC.',
      targets: ['Windows desktop'],
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', minLength: 1, maxLength: 120 } },
        required: ['message'],
        additionalProperties: false,
      },
    },
    scriptPath: path.join(rootPath, 'ShowDesktopMessage.ahk'),
    parameterSchema: messageSchema,
    timeoutMs: 30_000,
    buildArguments: parameters => [String(parameters.message)],
    successSummary: 'Desktop message closed successfully.',
    failureSummary: 'Desktop message did not complete.',
  };

  const definitions = new Map([[definition.metadata.id, definition]]);
  return {
    rootPath,
    list: () => [definition.metadata],
    get: id => definitions.get(id),
  };
}
