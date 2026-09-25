import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { McpToolResponse } from '../types/mcp-types.js';
import { safeParse } from '../core/validation-middleware.js';

// Legacy unregistered tool preserved for reference and possible future reactivation.

export const MemoryContextArgsSchema = z.object({
  memory_type: z
    .enum(['common-issues', 'all'])
    .default('all')
    .describe('Which memory to retrieve: common-issues or all'),
});

export type MemoryContextArgs = z.infer<typeof MemoryContextArgsSchema>;

export const memoryContextDefinition = {
  name: 'AHK_Memory_Context',
  description:
    'Retrieve AutoHotkey v2 memory context for common issues, patterns, and best practices. These memories help identify and prevent typical AHK v2 problems.',
  inputSchema: {
    type: 'object',
    properties: {
      memory_type: {
        type: 'string',
        enum: ['common-issues', 'all'],
        description: 'Which memory to retrieve',
        default: 'all',
      },
    },
  },
};

interface MemoryFile {
  name: string;
  path: string;
  content: string;
}

/**
 * Class-based implementation of AHK_Memory_Context tool
 */
export class AhkMemoryContextTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    try {
      const parsed = safeParse(args, MemoryContextArgsSchema, 'AHK_Memory_Context');
      if (!parsed.success) return parsed.error;

      const validatedArgs = parsed.data;
      const memoriesDir = path.join(process.cwd(), '.claude', 'memories');
      const memories: MemoryFile[] = [];

      // Check if memories directory exists
      try {
        await fs.access(memoriesDir);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: 'No memory files found. Create `.claude/memories/` directory with memory markdown files.',
            },
          ],
        };
      }

      // Define available memory files
      const memoryFiles = [{ name: 'common-issues', file: 'ahk-v2-common-issues.md' }];

      // Filter based on memory_type
      const filesToLoad =
        validatedArgs.memory_type === 'all'
          ? memoryFiles
          : memoryFiles.filter(m => m.name === validatedArgs.memory_type);

      // Load memory files
      for (const memFile of filesToLoad) {
        const memPath = path.join(memoriesDir, memFile.file);
        try {
          const content = await fs.readFile(memPath, 'utf-8');
          memories.push({
            name: memFile.name,
            path: memPath,
            content,
          });
        } catch {
          // Skip files that don't exist
          continue;
        }
      }

      if (memories.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No memory files found for type: ${validatedArgs.memory_type}`,
            },
          ],
        };
      }

      // Format response with memory content
      const response = [
        {
          type: 'text',
          text: `# AutoHotkey v2 Memory Context\n\nLoaded ${memories.length} memory file(s):\n`,
        },
      ];

      for (const memory of memories) {
        response.push({
          type: 'text',
          text: `\n## Memory: ${memory.name}\n\n${memory.content}`,
        });
      }

      return { content: response as McpToolResponse['content'] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error loading memory context: ${errorMessage}`,
          },
        ],
      };
    }
  }
}

// Legacy function for backward compatibility (can be removed after server.ts is updated)
export async function handleMemoryContext(args: MemoryContextArgs): Promise<McpToolResponse> {
  const tool = new AhkMemoryContextTool();
  return await tool.execute(args);
}
