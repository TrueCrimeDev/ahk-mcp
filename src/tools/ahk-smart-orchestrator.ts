import { z } from 'zod';
import logger from '../logger.js';
import { OrchestrationEngine, OrchestrationRequest } from '../core/orchestration-engine.js';
import { AhkCloudValidateTool } from './ahk-cloud-validate.js';

export const AhkSmartOrchestratorArgsSchema = z.object({
  intent: z.string().min(1).describe('High-level description of what you want to do'),
  filePath: z.string().optional().describe('Optional: Direct path to AHK file (skips detection)'),
  targetEntity: z
    .string()
    .optional()
    .describe('Optional: Specific class, method, or function name'),
  operation: z.enum(['view', 'edit', 'analyze']).default('view').describe('Operation type'),
  forceRefresh: z.boolean().optional().default(false).describe('Force re-analysis of file'),
  validate: z
    .boolean()
    .optional()
    .default(false)
    .describe('Validate file syntax before edit operations. Returns errors if validation fails.'),
});

export type AhkSmartOrchestratorArgs = z.infer<typeof AhkSmartOrchestratorArgsSchema>;

export const ahkSmartOrchestratorToolDefinition = {
  name: 'AHK_Smart_Orchestrator',
  description: `Orchestrates AHK file operations with smart caching. Chains detect→analyze→view/edit. Operations: view, edit, analyze.`,
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description:
          'High-level description of what you want to do (e.g., "edit the _Dark class checkbox methods")',
      },
      filePath: {
        type: 'string',
        description: 'Optional: Direct path to AHK file (skips detection if provided)',
      },
      targetEntity: {
        type: 'string',
        description:
          'Optional: Specific class, method, or function name to focus on (e.g., "_Dark", "_Dark.ColorCheckbox")',
      },
      operation: {
        type: 'string',
        enum: ['view', 'edit', 'analyze'],
        default: 'view',
        description:
          'Operation type: view (read-only), edit (prepare for editing), analyze (structure only)',
      },
      forceRefresh: {
        type: 'boolean',
        default: false,
        description: 'Force re-analysis even if cached data exists',
      },
      validate: {
        type: 'boolean',
        default: false,
        description: 'Validate file syntax before edit. Blocks if errors found.',
      },
    },
    required: ['intent'],
  },
};

export class AhkSmartOrchestratorTool {
  private engine: OrchestrationEngine;
  private validateTool: AhkCloudValidateTool;

  constructor() {
    this.engine = new OrchestrationEngine();
    this.validateTool = new AhkCloudValidateTool();
  }

  async execute(args: z.infer<typeof AhkSmartOrchestratorArgsSchema>): Promise<any> {
    try {
      const validatedArgs = AhkSmartOrchestratorArgsSchema.parse(args);

      logger.info('Smart Orchestrator called:', {
        intent: validatedArgs.intent,
        hasFilePath: !!validatedArgs.filePath,
        targetEntity: validatedArgs.targetEntity,
        operation: validatedArgs.operation,
        validate: validatedArgs.validate,
      });

      const request: OrchestrationRequest = {
        intent: validatedArgs.intent,
        filePath: validatedArgs.filePath,
        targetEntity: validatedArgs.targetEntity,
        operation: validatedArgs.operation,
        forceRefresh: validatedArgs.forceRefresh,
      };

      const result = await this.engine.orchestrate(request);

      // Validate file if requested and we have a file path
      if (validatedArgs.validate && result.success && result.metadata?.filePath) {
        logger.info(`Validating file: ${result.metadata.filePath}`);
        const fs = await import('fs/promises');
        try {
          const fileContent = await fs.readFile(result.metadata.filePath, 'utf-8');
          const validationResult = await this.validateTool.execute({ code: fileContent });

          // Parse validation response
          const validationText = validationResult.content?.[1]?.text || '';
          let validationData: any = {};
          try {
            const jsonMatch = validationText.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
              validationData = JSON.parse(jsonMatch[1]);
            }
          } catch {
            // Ignore parse errors
          }

          if (!validationData.success || (validationData.errors && validationData.errors.length > 0)) {
            const errorList = validationData.errors?.map((e: any) =>
              `- **${e.type}** (line ${e.line || '?'}): ${e.message}`
            ).join('\n') || 'Unknown validation error';

            return {
              content: [
                {
                  type: 'text',
                  text: `**Validation Failed**\n\n` +
                        `File: ${result.metadata.filePath}\n\n` +
                        `Errors found:\n${errorList}\n\n` +
                        `Fix these errors before editing.`,
                },
              ],
              isError: true,
            };
          }

          // Add validation success to result
          result.context = `✓ **Validation Passed**\n\n${result.context}`;
        } catch (readError) {
          logger.warn(`Failed to read file for validation: ${readError}`);
        }
      }

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: this.formatErrorResponse(result),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: result.context,
          },
        ],
      };
    } catch (error) {
      logger.error('Error in AHK_Smart_Orchestrator:', error);
      return {
        content: [
          {
            type: 'text',
            text: `[ERROR] **Orchestration Error**\n\n${error instanceof Error ? error.message : String(error)}\n\n**Tip:** Ensure you provide a valid intent and, if needed, an explicit file path.`,
          },
        ],
        isError: true,
      };
    }
  }

  private formatErrorResponse(result: any): string {
    const lines: string[] = [
      '[ERROR] **Orchestration Failed**\n',
      `Tool calls made: ${result.toolCallsMade}\n`,
    ];

    if (result.errors && result.errors.length > 0) {
      lines.push('**Errors:**');
      result.errors.forEach((err: string) => lines.push(`• ${err}`));
      lines.push('');
    }

    lines.push('**Suggestions:**');
    lines.push('• Provide explicit filePath parameter if detection fails');
    lines.push('• Use operation: "analyze" to see available entities');
    lines.push('• Check that file exists and has .ahk extension');

    return lines.join('\n');
  }
}
