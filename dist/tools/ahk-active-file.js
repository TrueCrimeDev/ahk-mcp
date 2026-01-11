import { z } from 'zod';
import logger from '../logger.js';
import { loadConfig } from '../core/config.js';
import { getActiveFilePath, setActiveFilePath } from '../core/active-file.js';
import { safeParse } from '../core/validation-middleware.js';
export const AhkActiveFileArgsSchema = z.object({
    action: z.enum(['get', 'set']).default('get'),
    filePath: z.string().optional(),
});
export const ahkActiveFileToolDefinition = {
    name: 'AHK_Active_File',
    description: `Ahk active file
Get or set the active AHK file path used as a default when invoking tools.`,
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set'], default: 'get' },
            filePath: { type: 'string', description: 'Absolute AHK file path to set as active' },
        },
    },
};
export class AhkActiveFileTool {
    async execute(args) {
        const parsed = safeParse(args, AhkActiveFileArgsSchema, 'AHK_Active_File');
        if (!parsed.success)
            return parsed.error;
        const { action, filePath } = parsed.data;
        try {
            if (action === 'get') {
                const cfg = loadConfig();
                const current = getActiveFilePath();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ activeFile: current || null, persisted: cfg.activeFile || null }, null, 2),
                        },
                    ],
                };
            }
            if (!filePath) {
                throw new Error('filePath is required for set action');
            }
            const setSuccess = setActiveFilePath(filePath);
            if (!setSuccess) {
                throw new Error(`Failed to set active file: ${filePath}`);
            }
            const updated = loadConfig();
            return {
                content: [
                    { type: 'text', text: 'Active file updated.' },
                    {
                        type: 'text',
                        text: JSON.stringify({ activeFile: updated.activeFile || null }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error('Error in AHK_Active_File tool:', error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `[ERROR]: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    }
}
