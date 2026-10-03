import { z } from 'zod/v3';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { toolAnalytics } from '../core/tool-analytics.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkAnalyticsArgsSchema = z.object({
  action: z.enum(['summary', 'tool_stats', 'recent', 'export', 'clear']).default('summary'),
  toolName: z.string().optional().describe('Tool name for tool_stats action'),
  limit: z.number().min(1).max(500).optional().default(50).describe('Limit for recent metrics'),
});

export type AhkAnalyticsToolArgs = z.infer<typeof AhkAnalyticsArgsSchema>;

export const ahkAnalyticsToolDefinition = {
  name: 'AHK_Analytics',
  description: `View tool usage analytics and performance metrics. Track success rates, execution times, common errors, and usage patterns across all MCP tools. Actions: summary (overall stats), tool_stats (specific tool), recent (recent calls), export (JSON data), clear (reset). Use to diagnose tool issues or optimize workflows.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['summary', 'tool_stats', 'recent', 'export', 'clear'],
        default: 'summary',
        description: 'Action to perform',
      },
      toolName: {
        type: 'string',
        description: 'Tool name for tool_stats action',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Limit for recent metrics',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['summary', 'tool_stats', 'recent', 'export', 'clear', 'error'],
      },
      action: { type: 'string' },
      message: { type: 'string' },
      totalCalls: { type: 'number' },
      uniqueTools: { type: 'number' },
      overallSuccessRate: { type: 'number' },
      averageDuration: { type: 'number' },
      topTools: { type: 'array', items: { type: 'object' } },
      problematicTools: { type: 'array', items: { type: 'object' } },
      stats: { type: 'object' },
      metrics: { type: 'array', items: { type: 'object' } },
      data: { type: 'object' },
    },
    required: ['kind', 'action'],
  },
};

export class AhkAnalyticsTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    try {
      const parsed = safeParse(args, AhkAnalyticsArgsSchema, 'AHK_Analytics');
      if (!parsed.success) return parsed.error;

      const { action, toolName, limit } = parsed.data;

      logger.info(`Analytics action: ${action}`);

      let response = '';
      let structuredContent: Record<string, unknown> = {
        kind: action,
        action,
      };

      switch (action) {
        case 'summary': {
          const summary = toolAnalytics.getSummary();
          structuredContent = {
            kind: 'summary',
            action,
            ...summary,
          };
          response = `# Tool Usage Analytics Summary\n\n`;
          response += `## Overall Statistics\n`;
          response += `- **Total Calls:** ${summary.totalCalls}\n`;
          response += `- **Unique Tools:** ${summary.uniqueTools}\n`;
          response += `- **Success Rate:** ${summary.overallSuccessRate.toFixed(2)}%\n`;
          response += `- **Average Duration:** ${summary.averageDuration.toFixed(2)}ms\n\n`;

          if (summary.topTools.length > 0) {
            response += `## Most Used Tools\n`;
            summary.topTools.forEach((tool, index) => {
              response += `${index + 1}. **${tool.toolName}**: ${tool.calls} calls\n`;
            });
            response += `\n`;
          }

          if (summary.problematicTools.length > 0) {
            response += `## [WARN] Problematic Tools (High Failure Rate)\n`;
            summary.problematicTools.forEach(tool => {
              response += `- **${tool.toolName}**: ${tool.failureRate.toFixed(2)}% failure rate\n`;
            });
            response += `\n`;
          }
          break;
        }

        case 'tool_stats': {
          if (!toolName) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: toolName parameter required for tool_stats action',
                },
              ],
              structuredContent: {
                kind: 'error',
                action,
                message: 'toolName parameter required for tool_stats action',
              },
              isError: true,
            };
          }

          const stats = toolAnalytics.getToolStats(toolName);
          if (!stats) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No statistics found for tool: ${toolName}`,
                },
              ],
              structuredContent: {
                kind: 'tool_stats',
                action,
                message: `No statistics found for tool: ${toolName}`,
                stats: {},
              },
            };
          }

          structuredContent = {
            kind: 'tool_stats',
            action,
            stats: {
              toolName,
              totalCalls: stats.totalCalls,
              successfulCalls: stats.successfulCalls,
              failedCalls: stats.failedCalls,
              successRate: (stats.successfulCalls / stats.totalCalls) * 100,
              averageDuration: stats.averageDuration,
              lastUsed: stats.lastUsed,
              commonErrors: Object.fromEntries(stats.commonErrors),
            },
          };
          response = `# Statistics for ${toolName}\n\n`;
          response += `## Usage Metrics\n`;
          response += `- **Total Calls:** ${stats.totalCalls}\n`;
          response += `- **Successful Calls:** ${stats.successfulCalls}\n`;
          response += `- **Failed Calls:** ${stats.failedCalls}\n`;
          response += `- **Success Rate:** ${((stats.successfulCalls / stats.totalCalls) * 100).toFixed(2)}%\n`;
          response += `- **Average Duration:** ${stats.averageDuration.toFixed(2)}ms\n`;
          response += `- **Last Used:** ${new Date(stats.lastUsed).toISOString()}\n\n`;

          if (stats.commonErrors.size > 0) {
            response += `## Common Errors\n`;
            Array.from(stats.commonErrors.entries())
              .sort((a, b) => b[1] - a[1])
              .forEach(([errorType, count]) => {
                response += `- **${errorType}**: ${count} occurrences\n`;
              });
          }
          break;
        }

        case 'recent': {
          const recent = toolAnalytics.getRecentMetrics(limit);
          structuredContent = {
            kind: 'recent',
            action,
            metrics: [...recent].reverse(),
          };
          response = `# Recent Tool Calls (Last ${recent.length})\n\n`;

          [...recent].reverse().forEach((metric, index) => {
            const status = metric.success ? '[OK]' : '[ERROR]';
            const timestamp = new Date(metric.timestamp).toISOString();
            response += `${index + 1}. ${status} **${metric.toolName}** - ${metric.duration}ms (${timestamp})\n`;
            if (!metric.success && metric.errorMessage) {
              response += `   Error: ${metric.errorMessage}\n`;
            }
          });
          break;
        }

        case 'export': {
          const exportData = JSON.parse(toolAnalytics.exportMetrics()) as Record<string, unknown>;
          structuredContent = {
            kind: 'export',
            action,
            data: exportData,
          };
          response = `# Exported Analytics Data\n\n`;
          response += `\`\`\`json\n${JSON.stringify(exportData, null, 2)}\n\`\`\``;
          break;
        }

        case 'clear': {
          toolAnalytics.clear();
          structuredContent = {
            kind: 'clear',
            action,
            message: 'All tool usage analytics have been cleared.',
          };
          response = `# Analytics Cleared\n\nAll tool usage analytics have been cleared.`;
          break;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
        structuredContent,
      };
    } catch (error) {
      logger.error('Error in analytics tool:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${message}`,
          },
        ],
        structuredContent: {
          kind: 'error',
          action: 'unknown',
          message,
        },
        isError: true,
      };
    }
  }
}
