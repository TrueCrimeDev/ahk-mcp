import { z } from 'zod';
import { getAhkIndex, getAhkDocumentationFull } from '../core/loader.js';
import { ClaudeStandardsEngine } from '../core/claude-standards.js';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { AhkDocFullVariable, AhkDocFullClassItem } from '../types/tool-types.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkSummaryArgsSchema = z.object({});

export const ahkSummaryToolDefinition = {
  name: 'AHK_Summary',
  description: `Returns a summary of built-in variables, classes, and coding standards for AutoHotkey v2.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

interface SummaryVariable {
  name: string;
  type: string;
  description: string;
}

interface SummaryClass {
  name: string;
  description: string;
}

interface SummaryMethod {
  name: string;
  returnType: string;
  description: string;
}

export class AhkSummaryTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkSummaryArgsSchema, 'AHK_Summary');
    if (!parsed.success) return parsed.error;

    logger.info('Generating enhanced AutoHotkey summary with full documentation');
    const index = getAhkIndex();
    const fullDocs = getAhkDocumentationFull();
    const standards = new ClaudeStandardsEngine().getStandards();

    // Use full documentation if available, fallback to index
    let variables: SummaryVariable[] = [];
    let classes: SummaryClass[] = [];
    let methods: SummaryMethod[] = [];
    let dataSource = 'index';

    if (fullDocs && fullDocs.data) {
      dataSource = 'full documentation';

      // Extract variables from full documentation
      if (fullDocs.data.BuiltInVariables) {
        variables = fullDocs.data.BuiltInVariables.map((v: AhkDocFullVariable) => ({
          name: v.Name,
          type: v.ReturnType || v.Type || 'Unknown',
          description: v.Description || 'No description available',
        }));
      }

      // Extract classes and methods from full documentation
      if (fullDocs.data.Classes) {
        const classItems = (fullDocs.data.Classes ?? []).filter(
          (item: AhkDocFullClassItem) => item.Type === 'Class' || !item.Path
        );
        const methodItems = (fullDocs.data.Classes ?? []).filter(
          (item: AhkDocFullClassItem) => item.Type === 'Method' && item.Path
        );

        classes = classItems.map((c: AhkDocFullClassItem) => ({
          name: c.Name,
          description: c.Description || 'No description available',
        }));

        methods = methodItems.map((m: AhkDocFullClassItem) => ({
          name: `${m.Path}.${m.Name}`,
          returnType: m.ReturnType || 'Unknown',
          description: m.Description || 'No description available',
        }));
      }
    } else if (index) {
      // Fallback to index data
      variables = (index.variables ?? []).map(v => ({
        name: v.Name,
        type: v.Type,
        description: v.Description,
      }));
      classes = (index.classes ?? []).map(c => ({
        name: c.Name,
        description: c.Description,
      }));
      methods = (index.methods ?? []).map(m => ({
        name: m.Name,
        returnType: m.ReturnType || 'Unknown',
        description: m.Description,
      }));
    }

    const rules = (standards ?? []).map(s => ({
      name: s.name,
      message: s.message,
      category: s.category,
    }));

    // Create enhanced summary text
    let summaryText = `## AutoHotkey v2 Enhanced Summary\n*Data source: ${dataSource}*\n\n`;

    summaryText += `**Built-in Variables:** ${variables.length}\n`;
    summaryText += variables
      .slice(0, 10)
      .map(v => `- ${v.name} (${v.type}): ${v.description}`)
      .join('\n');
    if (variables.length > 10) {
      summaryText += `\n...and ${variables.length - 10} more variables`;
    }

    summaryText += '\n\n';
    summaryText += `**Classes:** ${classes.length}\n`;
    summaryText += classes
      .slice(0, 10)
      .map(c => `- ${c.name}: ${c.description}`)
      .join('\n');
    if (classes.length > 10) {
      summaryText += `\n...and ${classes.length - 10} more classes`;
    }

    if (methods.length > 0) {
      summaryText += '\n\n';
      summaryText += `**Methods:** ${methods.length}\n`;
      summaryText += methods
        .slice(0, 5)
        .map(m => `- ${m.name} → ${m.returnType}: ${m.description}`)
        .join('\n');
      if (methods.length > 5) {
        summaryText += `\n...and ${methods.length - 5} more methods`;
      }
    }

    summaryText += '\n\n';
    summaryText += `**Coding Standards:** ${rules.length}\n`;
    summaryText += rules.map(r => `- ${r.name}: ${r.message} (${r.category})`).join('\n');

    summaryText += '\n\n---\n\n';
    summaryText += `**Raw Data (JSON):**\n\`\`\`json\n${JSON.stringify(
      {
        dataSource,
        variables: variables.slice(0, 20),
        classes: classes.slice(0, 20),
        methods: methods.slice(0, 10),
        standards: rules,
      },
      null,
      2
    )}\n\`\`\``;

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
      ],
    };
  }
}
