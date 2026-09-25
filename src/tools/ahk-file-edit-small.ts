import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { activeFile } from '../core/active-file.js';
import { checkToolAvailability, toolSettings } from '../core/tool-settings.js';
import { createUnifiedDiff } from './ahk-file-edit-diff.js';
import { AhkRunTool } from './ahk-run-script.js';
import { resolveWithTracking, addDeprecationWarning } from '../core/parameter-aliases.js';
import { createPreviewGenerator } from '../utils/dry-run-preview.js';
import { safeParse } from '../core/validation-middleware.js';
import { setLastEditedFile } from '../core/config.js';
import { openFileInVSCode } from '../utils/vscode-open.js';
import { assertAllowedPath } from '../core/path-policy.js';

type EditAction =
  | 'replace_regex'
  | 'replace_literal'
  | 'line_replace'
  | 'line_delete'
  | 'line_insert_before'
  | 'line_insert_after';

export const AhkSmallEditArgsSchema = z.object({
  action: z
    .enum([
      'replace_regex',
      'replace_literal',
      'line_replace',
      'line_delete',
      'line_insert_before',
      'line_insert_after',
    ] as const)
    .default('replace_literal'),
  file: z
    .string()
    .optional()
    .describe('Target file to edit. Defaults to the active file when omitted.'),
  files: z.array(z.string()).optional().describe('Apply the same edit to multiple files.'),
  find: z
    .string()
    .optional()
    .describe('Text (or pattern) to search for when using replace actions.'),
  replace: z.string().optional().describe('Replacement text for replace actions.'),
  regexFlags: z
    .string()
    .optional()
    .describe('Additional RegExp flags (e.g. "i" for case-insensitive).'),
  all: z
    .boolean()
    .optional()
    .default(true)
    .describe('Replace all occurrences (false = first only).'),
  line: z.number().optional().describe('Line number for line-based actions (1-based).'),
  startLine: z.number().optional().describe('Start line for range operations (1-based).'),
  endLine: z
    .number()
    .optional()
    .describe('End line for range delete or replace (1-based, inclusive).'),
  content: z.string().optional().describe('⚠️ Deprecated alias for newContent.'),
  newContent: z
    .string()
    .optional()
    .describe(
      'Primary text to insert or replace during line actions. Example: "MsgBox(\\"Updated\\")".'
    ),
  preview: z
    .boolean()
    .optional()
    .default(false)
    .describe('Show a unified diff instead of writing to disk.'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview changes without modifying file. Shows affected lines and change count.'),
  backup: z
    .boolean()
    .optional()
    .default(false)
    .describe('Create a .bak backup before writing changes.'),
  runAfter: z
    .boolean()
    .optional()
    .describe('Run the script after edits complete (single file only).'),
});

type SmallEditArgs = z.infer<typeof AhkSmallEditArgsSchema>;

export const ahkSmallEditToolDefinition = {
  name: 'AHK_File_Edit_Small',
  description: `Token-efficient editor for small, targeted changes. Ideal when you need a lightweight replace or line edit without loading the full diff engine. Supports regex and literal replacements, multi-file batches, optional diff previews, and dry-run mode.

**Common Replace**
\`\`\`json
{
  "action": "replace_literal",
  "file": "C:\\\\Scripts\\\\MyScript.ahk",
  "find": "Sleep(500)",
  "replace": "Sleep(100)"
}
\`\`\`

**Insert Before a Line (Preview)**
\`\`\`json
{
  "action": "line_insert_before",
  "file": "C:\\\\Scripts\\\\TrayMenu.ahk",
  "line": 42,
  "newContent": "    TrayTip(\\"Menu refreshed\\")",
  "dryRun": true
}
\`\`\`

**Multi-File Regex Replace**
\`\`\`json
{
  "action": "replace_regex",
  "files": ["core.ahk", "ui.ahk"],
  "find": "SetTimer\\\\((\\\\w+), 5000\\\\)",
  "replace": "SetTimer($1, 10000)",
  "all": true
}
\`\`\`

**What to Avoid**
- Mixing deprecated "content" parameter with newContent - prefer newContent
- Running multi-file edits without \`dryRun: true\` to preview
- Forgetting \`backup: true\` when touching critical scripts

**See also:** AHK_File_Edit (full-featured editor), AHK_File_Edit_Diff (complex diffs), AHK_File_Edit_Advanced`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'replace_regex',
          'replace_literal',
          'line_replace',
          'line_delete',
          'line_insert_before',
          'line_insert_after',
        ],
        default: 'replace_literal',
        description: 'Edit action to perform (default: replace_literal for safe string matching)',
      },
      file: {
        type: 'string',
        description: 'Target file to edit. Defaults to the active file when omitted.',
      },
      files: {
        type: 'array',
        description: 'Apply the same edit to multiple files.',
        items: { type: 'string' },
      },
      find: {
        type: 'string',
        description: 'Text (or pattern) to search for when using replace actions.',
      },
      replace: {
        type: 'string',
        description: 'Replacement text for replace actions.',
      },
      regexFlags: {
        type: 'string',
        description: 'Additional RegExp flags (e.g. "i" for case-insensitive).',
      },
      all: {
        type: 'boolean',
        default: true,
        description: 'Replace all occurrences (false = first only).',
      },
      line: {
        type: 'number',
        description: 'Line number for line-based actions (1-based).',
      },
      startLine: {
        type: 'number',
        description: 'Start line for range operations (1-based).',
      },
      endLine: {
        type: 'number',
        description: 'End line for range delete or replace (1-based, inclusive).',
      },
      content: {
        type: 'string',
        description: '⚠️ Deprecated alias for newContent. Prefer newContent for new text.',
      },
      newContent: {
        type: 'string',
        description:
          'Content to insert or replace when using line actions. Example: "MsgBox(\\"Done\\")".',
      },
      preview: {
        type: 'boolean',
        default: false,
        description: 'Show a unified diff instead of writing to disk.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description:
          'Preview changes without modifying file. Shows affected lines and change count.',
      },
      backup: {
        type: 'boolean',
        default: false,
        description: 'Create a .bak backup before writing changes.',
      },
      runAfter: {
        type: 'boolean',
        description: 'Run the script after edits complete (single file only).',
      },
    },
  },
};

interface EditResult {
  changed: boolean;
  newContent: string;
  summary: string;
}

interface ToolMessage {
  type: 'text';
  text: string;
}

interface ToolResponse {
  content: ToolMessage[];
  isError?: boolean;
}

export class AhkSmallEditTool {
  private runTool: AhkRunTool;

  constructor() {
    this.runTool = new AhkRunTool();
  }

  async execute(rawArgs: unknown): Promise<ToolResponse> {
    const parsed = safeParse(rawArgs, AhkSmallEditArgsSchema, 'AHK_File_Edit_Small');
    if (!parsed.success) return parsed.error as ToolResponse;

    try {
      const availability = checkToolAvailability('AHK_File_Edit_Small');
      if (!availability.enabled) {
        return {
          content: [{ type: 'text', text: availability.message || 'Tool is disabled' }],
        };
      }

      const args = parsed.data;
      const runAfter =
        typeof args.runAfter === 'boolean' ? args.runAfter : toolSettings.shouldAutoRunAfterEdit();

      // Apply parameter aliases for backward compatibility
      const { content: resolvedContent, deprecatedUsed } = resolveWithTracking(args);

      // Use resolved content if available, otherwise use the original content parameter
      // Cast needed: spreading a Zod inferred type loses non-optionality of defaulted fields
      const normalizedArgs = {
        ...args,
        content: resolvedContent !== undefined ? resolvedContent : args.content,
      } as SmallEditArgs;

      const targets = await this.resolveTargets(normalizedArgs.file, normalizedArgs.files);

      if (targets.length === 0) {
        throw new Error('No target file provided and no active file set.');
      }

      const reports: string[] = [];
      const runMessages: string[] = [];
      let runHandled = false;
      let lastEditedPath: string | undefined;

      for (const target of targets) {
        const absolutePath = path.resolve(target);
        await assertAllowedPath(absolutePath, 'write');

        let original: string;
        try {
          original = await fs.readFile(absolutePath, 'utf-8');
        } catch (error) {
          reports.push(
            `[ERROR] ${absolutePath}: failed to read file (${error instanceof Error ? error.message : String(error)})`
          );
          continue;
        }

        const result = this.applyEdit(absolutePath, original, normalizedArgs);

        if (!result.changed) {
          reports.push(`[WARN] ${absolutePath}: no changes detected`);
          continue;
        }

        if (args.preview || args.dryRun) {
          if (args.dryRun) {
            // Use the new dry-run preview generator
            const previewGenerator = createPreviewGenerator();
            let preview;

            switch (args.action as EditAction) {
              case 'replace_regex':
                if (!args.find) {
                  reports.push(
                    `[ERROR] ${absolutePath}: Missing "find" pattern for regex replace.`
                  );
                  continue;
                }
                preview = previewGenerator.generatePreview(
                  original,
                  args.find,
                  args.replace ?? '',
                  {
                    regex: true,
                    all: args.all,
                  }
                );
                break;
              case 'replace_literal':
                if (!args.find) {
                  reports.push(`[ERROR] ${absolutePath}: Missing "find" text for literal replace.`);
                  continue;
                }
                preview = previewGenerator.generatePreview(
                  original,
                  args.find,
                  args.replace ?? '',
                  {
                    regex: false,
                    all: args.all,
                  }
                );
                break;
              case 'line_replace': {
                if (!normalizedArgs.content) {
                  reports.push(
                    `[ERROR] ${absolutePath}: Line replace requires "content" to provide new text.`
                  );
                  continue;
                }
                const { line, startLine, endLine } = normalizedArgs;
                const start = this.resolveLineIndex(line ?? startLine, original.split('\n').length);
                const end = this.resolveLineIndex(
                  endLine ?? line ?? startLine,
                  original.split('\n').length
                );
                preview = previewGenerator.generateDeletePreview(original, start + 1, end + 1);
                // For replace, we need to show both delete and insert
                const lines = original.split('\n');
                const beforeContent = lines.slice(0, start).join('\n');
                const afterContent = lines.slice(end + 1).join('\n');
                const insertPreview = previewGenerator.generateInsertPreview(
                  beforeContent + '\n' + afterContent,
                  start + 1,
                  normalizedArgs.content
                );
                // Combine the previews
                preview.summary.totalChanges += insertPreview.summary.totalChanges;
                if (preview.summary.characterDiff && insertPreview.summary.characterDiff) {
                  preview.summary.characterDiff.added += insertPreview.summary.characterDiff.added;
                }
                preview.samples.push(...insertPreview.samples);
                break;
              }
              case 'line_delete': {
                const {
                  line: delLine,
                  startLine: delStartLine,
                  endLine: delEndLine,
                } = normalizedArgs;
                const delStart = this.resolveLineIndex(
                  delLine ?? delStartLine,
                  original.split('\n').length
                );
                const delEnd = this.resolveLineIndex(
                  delEndLine ?? delLine ?? delStartLine,
                  original.split('\n').length
                );
                preview = previewGenerator.generateDeletePreview(
                  original,
                  delStart + 1,
                  delEnd + 1
                );
                break;
              }
              case 'line_insert_before':
              case 'line_insert_after': {
                if (!normalizedArgs.line) {
                  reports.push(
                    `[ERROR] ${absolutePath}: Line insert actions require a specific line number.`
                  );
                  continue;
                }
                if (!normalizedArgs.content) {
                  reports.push(`[ERROR] ${absolutePath}: Line insert actions require "content".`);
                  continue;
                }
                const insertLine =
                  args.action === 'line_insert_before'
                    ? normalizedArgs.line
                    : normalizedArgs.line + 1;
                preview = previewGenerator.generateInsertPreview(
                  original,
                  insertLine,
                  normalizedArgs.content
                );
                break;
              }
              default:
                reports.push(`[ERROR] ${absolutePath}: Unsupported action: ${args.action}`);
                continue;
            }

            reports.push(
              `[DRY RUN] ${absolutePath}: Preview:\n${previewGenerator.formatPreview(preview, absolutePath)}`
            );
          } else {
            // Use the existing preview functionality
            const diff = createUnifiedDiff(
              original,
              result.newContent,
              `${absolutePath}.orig`,
              `${absolutePath}.preview`
            );
            reports.push(`[PREVIEW] ${absolutePath}: diff:\n${diff}`);
          }

          if (runAfter && !runHandled) {
            runMessages.push(
              '[WARN] Run skipped during preview/dry-run mode. Apply changes without preview to execute the script.'
            );
            runHandled = true;
          }
          continue;
        }

        if (args.backup) {
          try {
            await fs.writeFile(`${absolutePath}.bak`, original, 'utf-8');
          } catch (error) {
            reports.push(
              `[ERROR] ${absolutePath}: failed to write backup (${error instanceof Error ? error.message : String(error)})`
            );
            continue;
          }
        }

        try {
          // Preserve the file's original line endings (don't rewrite CRLF as LF),
          // and write atomically via temp + rename.
          const eol = original.includes('\r\n') ? '\r\n' : '\n';
          const outContent = result.newContent.replace(/\r\n/g, '\n').replace(/\n/g, eol);
          const tmpPath = `${absolutePath}.tmp-${process.pid}`;
          await fs.writeFile(tmpPath, outContent, 'utf-8');
          await fs.rename(tmpPath, absolutePath);
          reports.push(
            `[OK] ${absolutePath}: ${result.summary}${args.backup ? ' (backup saved as .bak)' : ''}`
          );
          setLastEditedFile(absolutePath);
          lastEditedPath = absolutePath;

          if (runAfter && !runHandled) {
            if (targets.length > 1) {
              runMessages.push(
                '[WARN] Run skipped because multiple files were edited. Run the primary script manually if needed.'
              );
              runHandled = true;
            } else if (!absolutePath.toLowerCase().endsWith('.ahk')) {
              runMessages.push(
                `[WARN] Run skipped because ${absolutePath} is not an AutoHotkey script.`
              );
              runHandled = true;
            } else {
              try {
                const runResult = await this.runTool.execute({
                  mode: 'run',
                  filePath: absolutePath,
                  wait: true,
                  runner: 'native',
                  scriptArgs: [],
                  timeout: 30000,
                  killOnExit: true,
                  detectWindow: false,
                });

                if (runResult?.content?.length) {
                  const runText = (runResult.content as ToolMessage[])
                    .filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n');
                  runMessages.push(runText || 'Script executed.');
                } else {
                  runMessages.push('Script executed successfully.');
                }
              } catch (runError) {
                runMessages.push(
                  `[WARN] Failed to run script: ${runError instanceof Error ? runError.message : String(runError)}`
                );
              }
              runHandled = true;
            }
          }
        } catch (error) {
          reports.push(
            `[ERROR] ${absolutePath}: failed to write changes (${error instanceof Error ? error.message : String(error)})`
          );
        }
      }

      if (runMessages.length > 0) {
        reports.push(runMessages.join('\n'));
      }

      if (lastEditedPath && toolSettings.shouldOpenInVsCodeAfterEdit()) {
        try {
          await openFileInVSCode(lastEditedPath, { reuseWindow: true });
          reports.push(`[VS Code] Opened ${path.basename(lastEditedPath)}`);
        } catch (openError) {
          reports.push(
            `[VS Code] Failed to open file: ${openError instanceof Error ? openError.message : String(openError)}`
          );
        }
      }

      let response: ToolResponse = {
        content: [{ type: 'text' as const, text: reports.join('\n\n') }],
      };

      // Add deprecation warnings if any
      if (deprecatedUsed.length > 0) {
        response = addDeprecationWarning(response, deprecatedUsed);
      }

      return response;
    } catch (error) {
      logger.error('Error in AHK_File_Edit_Small tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private async resolveTargets(file?: string, files?: string[]): Promise<string[]> {
    if (files && files.length > 0) {
      return Array.from(new Set(files.map(f => f.trim()).filter(Boolean)));
    }

    if (file) {
      return [file];
    }

    const active = activeFile.getActiveFile();
    return active ? [active] : [];
  }

  private applyEdit(file: string, original: string, args: SmallEditArgs): EditResult {
    switch (args.action as EditAction) {
      case 'replace_regex':
        return this.applyRegexReplace(original, args);
      case 'replace_literal':
        return this.applyLiteralReplace(original, args);
      case 'line_replace':
        return this.applyLineReplace(original, args);
      case 'line_delete':
        return this.applyLineDelete(original, args);
      case 'line_insert_before':
      case 'line_insert_after':
        return this.applyLineInsert(original, args);
      default:
        throw new Error(`Unsupported action: ${args.action}`);
    }
  }

  private applyRegexReplace(content: string, args: SmallEditArgs): EditResult {
    if (!args.find) {
      throw new Error('Missing "find" pattern for regex replace.');
    }

    const flags = this.buildRegexFlags(args.regexFlags, args.all);
    const regex = new RegExp(args.find, flags);
    const replacement = args.replace ?? '';

    const matches = content.match(regex);
    if (!matches) {
      return { changed: false, newContent: content, summary: 'pattern not found' };
    }

    // Create a fresh regex for replacement to avoid lastIndex side-effects
    const replaceRegex = new RegExp(args.find, flags);
    const newContent = content.replace(replaceRegex, replacement);
    const replacements = args.all ? matches.length : 1;

    return {
      changed: newContent !== content,
      newContent,
      summary: `applied regex replace (${replacements} replacement${replacements === 1 ? '' : 's'})`,
    };
  }

  private applyLiteralReplace(content: string, args: SmallEditArgs): EditResult {
    if (!args.find) {
      throw new Error('Missing "find" text for literal replace.');
    }

    const replacement = args.replace ?? '';

    if (args.all) {
      if (!content.includes(args.find)) {
        return { changed: false, newContent: content, summary: 'text not found' };
      }
      const occurrences = content.split(args.find).length - 1;
      const newContent = content.split(args.find).join(replacement);
      return {
        changed: newContent !== content,
        newContent,
        summary: `replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'}`,
      };
    }

    const index = content.indexOf(args.find);
    if (index === -1) {
      return { changed: false, newContent: content, summary: 'text not found' };
    }

    const newContent =
      content.slice(0, index) + replacement + content.slice(index + args.find.length);
    return {
      changed: true,
      newContent,
      summary: 'replaced first occurrence',
    };
  }

  private applyLineReplace(content: string, args: SmallEditArgs): EditResult {
    const { line, startLine, endLine, content: replacement } = args;

    if (typeof replacement !== 'string') {
      throw new Error('Line replace requires "content" to provide new text.');
    }

    const lines = content.split('\n');
    const start = this.resolveLineIndex(line ?? startLine, lines.length);
    const end = this.resolveLineIndex(endLine ?? line ?? startLine, lines.length);

    if (start > end) {
      throw new Error('startLine cannot be greater than endLine.');
    }

    const updated = [...lines];
    const replacementLines = replacement.split('\n');
    updated.splice(start, end - start + 1, ...replacementLines);

    const newContent = updated.join('\n');

    return {
      changed: newContent !== content,
      newContent,
      summary: `replaced lines ${start + 1}-${end + 1}`,
    };
  }

  private applyLineDelete(content: string, args: SmallEditArgs): EditResult {
    const { line, startLine, endLine } = args;
    const lines = content.split('\n');
    const start = this.resolveLineIndex(line ?? startLine, lines.length);
    const end = this.resolveLineIndex(endLine ?? line ?? startLine, lines.length);

    if (start > end) {
      throw new Error('startLine cannot be greater than endLine for delete.');
    }

    const updated = [...lines];
    updated.splice(start, end - start + 1);

    const newContent = updated.join('\n');

    return {
      changed: newContent !== content,
      newContent,
      summary: `deleted lines ${start + 1}-${end + 1}`,
    };
  }

  private applyLineInsert(content: string, args: SmallEditArgs): EditResult {
    if (typeof args.line !== 'number') {
      throw new Error('Line insert actions require a specific line number.');
    }
    if (typeof args.content !== 'string') {
      throw new Error('Line insert actions require "content".');
    }

    const lines = content.split('\n');
    const index = this.resolveLineIndex(args.line, lines.length);
    const insertLines = args.content.split('\n');
    const updated = [...lines];

    if (args.action === 'line_insert_before') {
      updated.splice(index, 0, ...insertLines);
      return {
        changed: true,
        newContent: updated.join('\n'),
        summary: `inserted ${insertLines.length} line${insertLines.length === 1 ? '' : 's'} before line ${args.line}`,
      };
    }

    updated.splice(index + 1, 0, ...insertLines);
    return {
      changed: true,
      newContent: updated.join('\n'),
      summary: `inserted ${insertLines.length} line${insertLines.length === 1 ? '' : 's'} after line ${args.line}`,
    };
  }

  private resolveLineIndex(line: number | undefined, totalLines: number): number {
    if (typeof line !== 'number' || Number.isNaN(line)) {
      throw new Error('A valid line number is required.');
    }

    if (line < 1) {
      throw new Error('Line numbers are 1-based.');
    }

    if (line > totalLines) {
      throw new Error(
        `Line ${line} is out of range (file has ${totalLines} line${totalLines === 1 ? '' : 's'}).`
      );
    }

    return line - 1;
  }

  private buildRegexFlags(userFlags: string | undefined, replaceAll: boolean): string {
    let flags = userFlags || '';
    if (replaceAll && !flags.includes('g')) {
      flags += 'g';
    }
    return flags;
  }
}
