/**
 * AHK_Trace_Viewer - Distributed Tracing Query Tool
 *
 * View and analyze distributed traces for debugging and performance analysis.
 * Query traces by ID, tool name, or view recent traces with detailed timing information.
 */

import { z } from 'zod';
import logger from '../logger.js';
import { McpToolResponse, createTextResponse, createErrorResponse } from '../types/mcp-types.js';
import {
  tracer,
  formatTraceTree,
  formatTraceJSON,
  getTraceSummary,
  type Span,
} from '../core/tracing.js';

export const AhkTraceViewerArgsSchema = z.object({
  action: z
    .enum(['get', 'list', 'search', 'stats', 'clear'])
    .default('list')
    .describe('Action to perform'),
  traceId: z.string().optional().describe('Trace ID for "get" action'),
  toolName: z.string().optional().describe('Tool name for "search" action'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Maximum number of traces to return'),
  format: z
    .enum(['tree', 'json', 'summary'])
    .optional()
    .default('tree')
    .describe('Output format for trace display'),
});

export type AhkTraceViewerToolArgs = z.infer<typeof AhkTraceViewerArgsSchema>;

export const ahkTraceViewerToolDefinition = {
  name: 'AHK_Trace_Viewer',
  description: `Query and analyze distributed traces for debugging and performance analysis.

**Actions:**
- \`get\`: Retrieve a specific trace by ID with full span tree
- \`list\`: View recent traces (default, most recent first)
- \`search\`: Find traces by tool name
- \`stats\`: Show tracing system statistics
- \`clear\`: Clear all stored traces

**Use Cases:**
- Debug complex tool orchestration flows
- Analyze performance bottlenecks
- Understand tool call sequences
- Investigate errors with full context
- Track correlation across operations

**Examples:**
\`\`\`
// View recent traces
{ "action": "list", "limit": 10 }

// Get specific trace with tree view
{ "action": "get", "traceId": "abc123", "format": "tree" }

// Find all traces for a tool
{ "action": "search", "toolName": "AHK_Smart_Orchestrator" }

// Export trace as JSON
{ "action": "get", "traceId": "abc123", "format": "json" }
\`\`\`

**Output Formats:**
- \`tree\`: Hierarchical tree view with timings (human-readable)
- \`json\`: Full JSON export (machine-readable)
- \`summary\`: Quick overview with key metrics`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'list', 'search', 'stats', 'clear'],
        default: 'list',
        description: 'Action to perform',
      },
      traceId: {
        type: 'string',
        description: 'Trace ID for "get" action',
      },
      toolName: {
        type: 'string',
        description: 'Tool name for "search" action',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Maximum number of traces to return',
      },
      format: {
        type: 'string',
        enum: ['tree', 'json', 'summary'],
        default: 'tree',
        description: 'Output format for trace display',
      },
    },
  },
};

export class AhkTraceViewerTool {
  async execute(args: z.infer<typeof AhkTraceViewerArgsSchema>): Promise<McpToolResponse> {
    try {
      const validatedArgs = AhkTraceViewerArgsSchema.parse(args);
      const { action, traceId, toolName, limit, format } = validatedArgs;

      logger.info(`Trace viewer action: ${action}`);

      let response = '';

      switch (action) {
        case 'get': {
          if (!traceId) {
            return createErrorResponse('traceId parameter required for "get" action');
          }

          const trace = tracer.getTrace(traceId);
          if (!trace) {
            return createErrorResponse(`Trace not found: ${traceId}`);
          }

          response = this.formatTrace(trace, format);
          break;
        }

        case 'list': {
          const traces = tracer.getAllTraces(limit);

          if (traces.length === 0) {
            return createTextResponse(
              'No traces found. Traces are created when tracing is enabled and tools are executed.'
            );
          }

          response = `# Recent Traces (${traces.length})\n\n`;
          response += `Showing ${traces.length} most recent trace(s). Use \`format: "summary"\` for quick overview or \`action: "get"\` for detailed view.\n\n`;

          traces.forEach((trace, index) => {
            const summary = getTraceSummary(trace);
            const status = summary.errorCount > 0 ? '[ERROR]' : '[OK]';
            const duration = trace.duration !== undefined ? `${trace.duration}ms` : 'running';

            response += `## ${index + 1}. ${trace.name} ${status}\n`;
            response += `- **Trace ID:** \`${trace.traceId}\`\n`;
            response += `- **Duration:** ${duration}\n`;
            response += `- **Spans:** ${summary.spanCount}\n`;
            if (summary.errorCount > 0) {
              response += `- **Errors:** ${summary.errorCount}\n`;
            }
            response += `- **Started:** ${new Date(trace.startTime).toISOString()}\n`;

            // Show slowest child span
            if (summary.slowestSpans.length > 1) {
              const slowest = summary.slowestSpans[1]; // Skip root span
              if (slowest) {
                response += `- **Slowest Operation:** ${slowest.name} (${slowest.duration}ms)\n`;
              }
            }
            response += `\n`;
          });

          response += `\n**Tip:** Use \`{ "action": "get", "traceId": "..." }\` to view full trace details.`;
          break;
        }

        case 'search': {
          if (!toolName) {
            return createErrorResponse('toolName parameter required for "search" action');
          }

          const traces = tracer.getTracesByTool(toolName, limit);

          if (traces.length === 0) {
            return createTextResponse(`No traces found for tool: ${toolName}`);
          }

          response = `# Traces for Tool: ${toolName}\n\n`;
          response += `Found ${traces.length} trace(s) involving this tool.\n\n`;

          traces.forEach((trace, index) => {
            const summary = getTraceSummary(trace);
            const status = summary.errorCount > 0 ? '[ERROR]' : '[OK]';
            const duration = trace.duration !== undefined ? `${trace.duration}ms` : 'running';

            response += `## ${index + 1}. ${status} ${trace.name} (${duration})\n`;
            response += `- **Trace ID:** \`${trace.traceId}\`\n`;
            response += `- **Spans:** ${summary.spanCount}\n`;
            if (summary.errorCount > 0) {
              response += `- **Errors:** ${summary.errorCount}\n`;
            }
            response += `\n`;
          });
          break;
        }

        case 'stats': {
          const stats = tracer.getStats();
          const tracingEnabled = tracer.isEnabled();

          response = `# Tracing System Statistics\n\n`;
          response += `## Status\n`;
          response += `- **Tracing Enabled:** ${tracingEnabled ? 'Yes' : 'No'}\n`;
          response += `- **Active Spans:** ${stats.activeSpans}\n`;
          response += `- **Total Traces:** ${stats.totalTraces}\n`;
          response += `- **Max Traces:** ${stats.maxTraces}\n`;

          if (stats.oldestTrace) {
            const age = Date.now() - stats.oldestTrace;
            const ageMinutes = Math.floor(age / 60000);
            response += `- **Oldest Trace Age:** ${ageMinutes} minutes\n`;
          }

          response += `\n## Configuration\n`;
          response += `- **Environment:** ${process.env.AHK_MCP_TRACING_ENABLED ?? 'default (enabled)'}\n`;
          response += `- **Max Traces:** ${process.env.AHK_MCP_MAX_TRACES ?? '1000 (default)'}\n`;
          response += `- **Log Format:** ${process.env.AHK_MCP_LOG_FORMAT ?? 'text (default)'}\n`;

          if (!tracingEnabled) {
            response += `\n**Note:** Tracing is currently disabled. Set \`AHK_MCP_TRACING_ENABLED=true\` to enable.`;
          }

          if (stats.activeSpans > 0) {
            response += `\n\n**Warning:** ${stats.activeSpans} span(s) are still active (not ended).`;
          }
          break;
        }

        case 'clear': {
          tracer.clearTraces();
          return createTextResponse('All traces cleared successfully.');
        }

        default:
          return createErrorResponse(`Unknown action: ${action}`);
      }

      return createTextResponse(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Trace viewer error:', errorMessage);
      return createErrorResponse(`Trace viewer error: ${errorMessage}`);
    }
  }

  private formatTrace(trace: Span, format: 'tree' | 'json' | 'summary'): string {
    switch (format) {
      case 'tree': {
        const summary = getTraceSummary(trace);
        let output = `# Trace: ${trace.traceId}\n\n`;
        output += `**Root Span:** ${trace.name}\n`;
        output += `**Duration:** ${trace.duration !== undefined ? `${trace.duration}ms` : 'running'}\n`;
        output += `**Status:** ${trace.status.code === 'OK' ? 'Success' : trace.status.code === 'ERROR' ? 'Error' : 'Running'}\n`;
        output += `**Started:** ${new Date(trace.startTime).toISOString()}\n`;
        output += `**Spans:** ${summary.spanCount}\n`;
        if (summary.errorCount > 0) {
          output += `**Errors:** ${summary.errorCount}\n`;
        }
        output += `\n## Trace Tree\n\n\`\`\`\n`;
        output += formatTraceTree(trace);
        output += `\`\`\`\n`;

        if (summary.slowestSpans.length > 0) {
          output += `\n## Slowest Operations\n\n`;
          summary.slowestSpans.forEach((span, index) => {
            output += `${index + 1}. **${span.name}**: ${span.duration}ms\n`;
          });
        }

        return output;
      }

      case 'json': {
        return `# Trace JSON Export\n\n\`\`\`json\n${JSON.stringify(formatTraceJSON(trace), null, 2)}\n\`\`\``;
      }

      case 'summary': {
        const summary = getTraceSummary(trace);
        let output = `# Trace Summary: ${trace.traceId}\n\n`;
        output += `- **Root Span:** ${trace.name}\n`;
        output += `- **Duration:** ${trace.duration !== undefined ? `${trace.duration}ms` : 'running'}\n`;
        output += `- **Status:** ${trace.status.code}\n`;
        output += `- **Total Spans:** ${summary.spanCount}\n`;
        output += `- **Errors:** ${summary.errorCount}\n`;

        if (summary.slowestSpans.length > 0) {
          output += `\n**Slowest Operations:**\n`;
          summary.slowestSpans.slice(0, 3).forEach((span, index) => {
            output += `${index + 1}. ${span.name}: ${span.duration}ms\n`;
          });
        }

        return output;
      }
    }
  }
}
