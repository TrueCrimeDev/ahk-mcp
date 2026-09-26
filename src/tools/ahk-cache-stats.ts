/**
 * AHK_Cache_Stats Tool
 *
 * Exposes the check-result cache's telemetry (hits/misses/size) and
 * supports clearing the cache. Intended as a diagnostics surface for
 * verifying the mtime-keyed LRU cache is behaving as expected.
 */

import { z } from 'zod/v3';
import { checkCache } from '../core/check-cache.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkCacheStatsArgsSchema = z.object({
  action: z
    .enum(['stats', 'clear'])
    .optional()
    .default('stats')
    .describe('stats = return current counters; clear = drop all entries and reset counters.'),
});

export const ahkCacheStatsToolDefinition = {
  name: 'AHK_Cache_Stats',
  description:
    'Inspect or reset the mtime-keyed check-result cache. Returns hits, misses, current size, and maxSize.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['stats', 'clear'],
        default: 'stats',
        description: 'stats (default) or clear',
      },
    },
    required: [],
  },
};

export class AhkCacheStatsTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkCacheStatsArgsSchema, 'AHK_Cache_Stats');
    if (!parsed.success) return parsed.error;

    if (parsed.data.action === 'clear') {
      checkCache.clear();
    }

    const stats = checkCache.stats();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }
}
