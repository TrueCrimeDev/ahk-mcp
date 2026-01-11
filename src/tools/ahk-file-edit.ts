import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { activeFile } from '../core/active-file.js';
import { checkToolAvailability, toolSettings } from '../core/tool-settings.js';
import { handleEditFailure } from './ahk-system-alpha.js';
import { AhkRunTool } from './ahk-run-script.js';
import { AhkCloudValidateTool } from './ahk-cloud-validate.js';
import { resolveWithTracking, addDeprecationWarning } from '../core/parameter-aliases.js';
import { createPreviewGenerator } from '../utils/dry-run-preview.js';
import { pathConverter, PathFormat } from '../utils/path-converter.js';
import { pathInterceptor } from '../core/path-interceptor.js';
import { safeParse } from '../core/validation-middleware.js';
import { setLastEditedFile } from '../core/config.js';
import { openFileInVSCode } from '../utils/vscode-open.js';

export const AhkEditArgsSchema = z.object({
  action: z.enum(['replace', 'insert', 'delete', 'append', 'prepend', 'create']).default('replace'),
  search: z
    .string()
    .optional()
    .describe(
      'Text to search for during replace/delete operations (supports regex when regex: true)'
    ),
  content: z
    .string()
    .optional()
    .describe('⚠️ Deprecated alias for newContent. Prefer newContent: "MsgBox(\\"Updated\\")"'),
  newContent: z
    .string()
    .optional()
    .describe(
      'Primary parameter containing the replacement or inserted text. Example: "MsgBox(\\"Ready\\")"'
    ),
  line: z.number().optional().describe('Line number to target for insert/delete (1-based)'),
  startLine: z.number().optional().describe('Start line for range operations (1-based)'),
  endLine: z.number().optional().describe('End line for range operations (1-based, inclusive)'),
  filePath: z
    .string()
    .optional()
    .describe('Absolute or relative path to the AutoHotkey file to edit'),
  regex: z
    .boolean()
    .optional()
    .default(false)
    .describe('Enable regular expression matching for the search text'),
  all: z
    .boolean()
    .optional()
    .default(false)
    .describe('Replace all occurrences (false = first occurrence only)'),
  backup: z
    .boolean()
    .optional()
    .default(true)
    .describe('Create .bak backup before modifying the file'),
  runAfter: z.boolean().optional().describe('Run the script after the edit completes successfully'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Preview-only mode. When true, no files are modified and a "DRY RUN - No changes made" report is returned.'
    ),
  validate: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Validate AHK code before writing. When true, runs the resulting code through AHK_Cloud_Validate and blocks the edit if errors are found.'
    ),
});

export const ahkEditToolDefinition = {
  name: 'AHK_File_Edit',
  description: `Primary AutoHotkey file editor for direct on-disk modifications. Handles search/replace, line inserts, deletes, appends, prepends, and even new file creation. Supports regex, automatic backups, dry-run previews, and optional script execution after edits.

**Common Usage**
\`\`\`json
{
  "action": "replace",
  "search": "oldClassName",
  "newContent": "NewClassName",
  "filePath": "C:\\\\Scripts\\\\MyAutomation.ahk"
}
\`\`\`

**Batch Replace with Regex (Preview First)**
\`\`\`json
{
  "action": "replace",
  "search": "class\\\\s+(\\\\w+)",
  "newContent": "class Refactored$1",
  "regex": true,
  "all": true,
  "dryRun": true
}
\`\`\`
Shows a DRY RUN report instead of touching the file.

**Create New Script**
\`\`\`json
{
  "action": "create",
  "filePath": "C:\\\\AHK\\\\Helpers\\\\ClipboardTools.ahk",
  "newContent": "class ClipboardTools {\\n    __New() {\\n        ; init\\n    }\\n}"
}
\`\`\`

**What to Avoid**
- Using deprecated "content" parameter - migrate to "newContent"
- Running batch replacements without \`dryRun: true\` first
- Disabling backups on production files unless absolutely necessary

**See also:** AHK_File_Edit_Advanced, AHK_File_Edit_Small, AHK_File_View, AHK_Smart_Orchestrator`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['replace', 'insert', 'delete', 'append', 'prepend', 'create'],
        default: 'replace',
        description: 'Edit action to perform',
      },
      search: {
        type: 'string',
        description: 'Text to search for (for replace/delete)',
      },
      newContent: {
        type: 'string',
        description:
          'Preferred parameter containing the replacement or inserted text (e.g., "MsgBox(\\"Updated\\")").',
      },
      content: {
        type: 'string',
        description: '⚠️ Deprecated alias for newContent. Will be removed in a future release.',
      },
      line: {
        type: 'number',
        description: 'Line number for insert/delete (1-based)',
      },
      startLine: {
        type: 'number',
        description: 'Start line for range operations',
      },
      endLine: {
        type: 'number',
        description: 'End line for range operations',
      },
      filePath: {
        type: 'string',
        description: 'File to edit (defaults to activeFilePath)',
      },
      regex: {
        type: 'boolean',
        default: false,
        description: 'Use regex for search',
      },
      all: {
        type: 'boolean',
        default: false,
        description: 'Replace all occurrences',
      },
      backup: {
        type: 'boolean',
        default: true,
        description: 'Create backup before editing',
      },
      runAfter: {
        type: 'boolean',
        description: 'Run the script after the edit completes successfully',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description:
          'Preview changes without modifying file. Shows affected lines and change count.',
      },
      validate: {
        type: 'boolean',
        default: false,
        description:
          'Validate AHK code before writing. Blocks edit if syntax errors are found.',
      },
    },
  },
};

export class AhkEditTool {
  private runTool: AhkRunTool;
  private validateTool: AhkCloudValidateTool;

  constructor() {
    this.runTool = new AhkRunTool();
    this.validateTool = new AhkCloudValidateTool();
  }
  /**
   * Perform replace operation
   */
  private replace(
    content: string,
    search: string,
    replacement: string,
    useRegex: boolean,
    all: boolean
  ): string {
    if (useRegex) {
      const regex = new RegExp(search, all ? 'g' : '');
      return content.replace(regex, replacement);
    } else {
      if (all) {
        return content.split(search).join(replacement);
      } else {
        const index = content.indexOf(search);
        if (index === -1) {
          throw new Error(`Text not found: "${search}"`);
        }
        return content.substring(0, index) + replacement + content.substring(index + search.length);
      }
    }
  }

  /**
   * Insert content at a specific line
   */
  private insertAtLine(content: string, lineNum: number, newContent: string): string {
    const lines = content.split('\n');

    // Convert to 0-based index
    const index = lineNum - 1;

    if (index < 0 || index > lines.length) {
      throw new Error(`Line number ${lineNum} is out of range (1-${lines.length + 1})`);
    }

    // Insert the new content
    lines.splice(index, 0, newContent);

    return lines.join('\n');
  }

  /**
   * Delete lines or content
   */
  private deleteLines(content: string, startLine: number, endLine?: number): string {
    const lines = content.split('\n');

    // Convert to 0-based index
    const start = startLine - 1;
    const end = endLine ? endLine - 1 : start;

    if (start < 0 || start >= lines.length) {
      throw new Error(`Start line ${startLine} is out of range (1-${lines.length})`);
    }

    if (end < start || end >= lines.length) {
      throw new Error(`End line ${endLine} is out of range (${startLine}-${lines.length})`);
    }

    // Remove the lines
    lines.splice(start, end - start + 1);

    return lines.join('\n');
  }

  /**
   * Append content to the end of file
   */
  private append(content: string, newContent: string): string {
    if (content && !content.endsWith('\n')) {
      content += '\n';
    }
    return content + newContent;
  }

  /**
   * Prepend content to the beginning of file
   */
  private prepend(content: string, newContent: string): string {
    if (newContent && !newContent.endsWith('\n')) {
      newContent += '\n';
    }
    return newContent + content;
  }

  /**
   * Execute the edit tool
   */
  async execute(args: unknown): Promise<any> {
    let validatedArgs: any;
    try {
      const parsed = safeParse(args, AhkEditArgsSchema, 'AHK_File_Edit');
      if (!parsed.success) return parsed.error;

      validatedArgs = parsed.data;

      // Check if tool is enabled
      const availability = checkToolAvailability('AHK_File_Edit');
      if (!availability.enabled) {
        return {
          content: [{ type: 'text', text: availability.message || 'Tool is disabled' }],
        };
      }

      // Apply path interception for cross-platform compatibility
      const interceptionResult = pathInterceptor.interceptInput('AHK_File_Edit', validatedArgs);
      if (!interceptionResult.success) {
        logger.warn(`Path interception failed: ${interceptionResult.error}`);
      } else {
        validatedArgs = AhkEditArgsSchema.parse(interceptionResult.modifiedData);
        if (interceptionResult.conversions.length > 0) {
          logger.debug(
            `Path conversions applied: ${interceptionResult.conversions.length} paths converted`
          );
        }
      }

      const {
        action,
        search,
        line,
        startLine,
        endLine,
        filePath,
        regex,
        all,
        backup,
        runAfter,
        dryRun,
        validate,
      } = validatedArgs;
      const shouldRunAfterEdit =
        typeof runAfter === 'boolean' ? runAfter : toolSettings.shouldAutoRunAfterEdit();

      // Apply parameter aliases for backward compatibility
      const { content: resolvedContent, deprecatedUsed } = resolveWithTracking(validatedArgs);
      const content = resolvedContent;

      // Get the target file
      let targetFile = filePath || activeFile.getActiveFile();
      if (!targetFile) {
        throw new Error(
          'No file specified and no active file set. Use AHK_File_Active to set an active file first.'
        );
      }

      // Apply path conversion for cross-platform compatibility
      try {
        const pathConversion = pathConverter.autoConvert(targetFile, PathFormat.WINDOWS);
        if (pathConversion.success) {
          targetFile = pathConversion.convertedPath;
          logger.debug(`Path converted from ${pathConversion.originalPath} to ${targetFile}`);
        } else {
          logger.warn(`Path conversion failed: ${pathConversion.error}`);
        }
      } catch (error) {
        logger.warn(
          `Path conversion error: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Ensure it's an .ahk file
      if (!targetFile.toLowerCase().endsWith('.ahk')) {
        throw new Error('Can only edit .ahk files');
      }

      // Read the current content
      let currentContent: string;
      try {
        currentContent = await fs.readFile(targetFile, 'utf-8');
      } catch (error) {
        // For create action, it's okay if file doesn't exist
        if (action === 'create' && (error as any).code === 'ENOENT') {
          currentContent = '';
        } else {
          throw new Error(`Failed to read file: ${targetFile}`);
        }
      }

      // Handle dry-run mode
      if (dryRun) {
        const previewGenerator = createPreviewGenerator();
        let preview;

        switch (action) {
          case 'replace':
            if (!search) {
              throw new Error('Search text is required for replace action');
            }
            if (content === undefined) {
              throw new Error('Content is required for replace action');
            }
            preview = previewGenerator.generatePreview(currentContent, search, content, {
              regex,
              all,
            });
            break;

          case 'insert':
            if (!line) {
              throw new Error('Line number is required for insert action');
            }
            if (content === undefined) {
              throw new Error('Content is required for insert action');
            }
            preview = previewGenerator.generateInsertPreview(currentContent, line, content);
            break;

          case 'delete':
            if (search) {
              // Delete by search
              preview = previewGenerator.generatePreview(currentContent, search, '', {
                regex,
                all,
              });
            } else if (line || startLine) {
              // Delete by line
              const start = line || startLine!;
              const end = endLine || start;
              preview = previewGenerator.generateDeletePreview(currentContent, start, end);
            } else {
              throw new Error('Either search text or line number is required for delete action');
            }
            break;

          case 'append':
            if (content === undefined) {
              throw new Error('Content is required for append action');
            }
            // For append, we'll simulate by inserting at end of file
            const lines = currentContent.split('\n');
            preview = previewGenerator.generateInsertPreview(
              currentContent,
              lines.length + 1,
              content
            );
            break;

          case 'prepend':
            if (content === undefined) {
              throw new Error('Content is required for prepend action');
            }
            // For prepend, we'll simulate by inserting at beginning of file
            preview = previewGenerator.generateInsertPreview(currentContent, 1, content);
            break;

          case 'create':
            if (content === undefined) {
              throw new Error('Content is required for create action');
            }
            // For create, we'll show what would be created
            preview = previewGenerator.generateInsertPreview('', 1, content);
            break;

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        let response = previewGenerator.formatPreview(preview, targetFile);

        // Add deprecation warnings if any
        if (deprecatedUsed.length > 0) {
          response =
            `**Deprecated parameter(s)**: ${deprecatedUsed.join(', ')}\n` +
            `Please update to new parameter names. See tool documentation for details.\n\n` +
            response;
        }

        let result = {
          content: [
            {
              type: 'text',
              text: response,
            },
          ],
        };

        // Add deprecation warnings if any
        if (deprecatedUsed.length > 0) {
          result = addDeprecationWarning(result, deprecatedUsed);
        }

        return result;
      }

      // Perform the edit operation
      let newContent: string;
      let operationSummary: string;

      switch (action) {
        case 'replace': {
          if (!search) {
            throw new Error('Search text is required for replace action');
          }
          if (content === undefined) {
            throw new Error('Content is required for replace action');
          }
          newContent = this.replace(currentContent, search, content, regex, all);
          operationSummary = `Replaced ${all ? 'all occurrences of' : 'first occurrence of'} "${search}" with "${content}"`;
          break;
        }

        case 'insert': {
          if (!line) {
            throw new Error('Line number is required for insert action');
          }
          if (content === undefined) {
            throw new Error('Content is required for insert action');
          }
          newContent = this.insertAtLine(currentContent, line, content);
          operationSummary = `Inserted content at line ${line}`;
          break;
        }

        case 'delete': {
          if (search) {
            // Delete by search
            newContent = this.replace(currentContent, search, '', regex, all);
            operationSummary = `Deleted ${all ? 'all occurrences of' : 'first occurrence of'} "${search}"`;
          } else if (line || startLine) {
            // Delete by line
            const start = line || startLine;
            if (start === undefined) {
              throw new Error('Start line is required for delete action');
            }
            const end = endLine || start;
            newContent = this.deleteLines(currentContent, start, end);
            operationSummary = `Deleted line${start === end ? '' : 's'} ${start}${start === end ? '' : `-${end}`}`;
          } else {
            throw new Error('Either search text or line number is required for delete action');
          }
          break;
        }

        case 'append': {
          if (content === undefined) {
            throw new Error('Content is required for append action');
          }
          newContent = this.append(currentContent, content);
          operationSummary = `Appended content to end of file`;
          break;
        }

        case 'prepend': {
          if (content === undefined) {
            throw new Error('Content is required for prepend action');
          }
          newContent = this.prepend(currentContent, content);
          operationSummary = `Prepended content to beginning of file`;
          break;
        }

        case 'create': {
          if (content === undefined) {
            throw new Error('Content is required for create action');
          }

          // Create parent directories if they don't exist
          const dir = path.dirname(targetFile);
          try {
            await fs.mkdir(dir, { recursive: true });
          } catch (error) {
            throw new Error(`Failed to create directory: ${dir}`);
          }

          // Atomic create-or-fail using 'wx' flag (exclusive write)
          // This prevents TOCTOU race conditions
          try {
            await fs.writeFile(targetFile, content, { encoding: 'utf-8', flag: 'wx' });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new Error(`File already exists: ${targetFile}`);
            }
            throw error;
          }

          newContent = content;
          operationSummary = `Created new file with content`;

          // Skip the normal writeFile at the end since we already wrote
          if (backup) {
            // No backup needed for new files
          }

          // Update active file
          activeFile.setActiveFile(targetFile);
          setLastEditedFile(targetFile);

          let vscodeNote = '';
          if (toolSettings.shouldOpenInVsCodeAfterEdit()) {
            try {
              await openFileInVSCode(targetFile, { reuseWindow: true });
              vscodeNote = `\n\n**VS Code:** Opened ${path.basename(targetFile)}`;
            } catch (openError) {
              vscodeNote = `\n\n**VS Code:** Failed to open file (${openError instanceof Error ? openError.message : String(openError)})`;
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: `**File Created Successfully**\n\n- **File**: \`${targetFile}\`\n- **Operation**: ${operationSummary}\n- **Lines**: ${content.split('\n').length}${vscodeNote}`,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // Validate new content if requested
      if (validate) {
        logger.info('Validating AHK code before write...');
        const validationResult = await this.validateTool.execute({ code: newContent });

        // Parse validation response
        const validationText = validationResult.content?.[1]?.text || '';
        let validationData: any = {};
        try {
          const jsonMatch = validationText.match(/```json\n([\s\S]*?)\n```/);
          if (jsonMatch) {
            validationData = JSON.parse(jsonMatch[1]);
          }
        } catch {
          // Fallback: check for errors in first content block
        }

        if (!validationData.success || (validationData.errors && validationData.errors.length > 0)) {
          const errorList = validationData.errors?.map((e: any) =>
            `- **${e.type}** (line ${e.line || '?'}): ${e.message}`
          ).join('\n') || 'Unknown validation error';

          return {
            content: [
              {
                type: 'text',
                text: `**Edit Blocked - Validation Failed**\n\n` +
                      `The edit would introduce syntax errors:\n\n${errorList}\n\n` +
                      `**File not modified.** Fix the code and try again, or set \`validate: false\` to skip validation.`,
              },
            ],
            isError: true,
          };
        }
        logger.info('Validation passed');
      }

      // Create backup if requested
      if (backup) {
        const backupPath = targetFile + '.bak';
        await fs.writeFile(backupPath, currentContent, 'utf-8');
        logger.info(`Backup created: ${backupPath}`);
      }

      // Write the new content
      await fs.writeFile(targetFile, newContent, 'utf-8');

      // Update active file to ensure it's current
      activeFile.setActiveFile(targetFile);
      setLastEditedFile(targetFile);

      // Generate response
      let response = `**Edit Successful**\n\n`;
      response += `**File:** ${targetFile}\n`;
      response += `**Operation:** ${operationSummary}\n`;

      // Show statistics
      const oldLines = currentContent.split('\n').length;
      const newLines = newContent.split('\n').length;
      const linesDiff = newLines - oldLines;

      response += `\n**Statistics:**\n`;
      response += `- Lines before: ${oldLines}\n`;
      response += `- Lines after: ${newLines}\n`;
      if (linesDiff > 0) {
        response += `- Lines added: ${linesDiff}\n`;
      } else if (linesDiff < 0) {
        response += `- Lines removed: ${Math.abs(linesDiff)}\n`;
      }

      if (backup) {
        response += `\nBackup saved as: ${path.basename(targetFile)}.bak`;
      }

      if (shouldRunAfterEdit) {
        response += '\n\n**Run Result:**\n';
        try {
          const runResult = await this.runTool.execute({
            mode: 'run',
            filePath: targetFile,
            wait: true,
            runner: 'native',
            scriptArgs: [],
            timeout: 30000,
            killOnExit: true,
            detectWindow: false,
          } as any);

          if (runResult?.content?.length) {
            const runText = runResult.content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join('\n');
            response += runText || 'Script executed.';
          } else {
            response += 'Script executed.';
          }
        } catch (runError) {
          response += `Failed to run script: ${runError instanceof Error ? runError.message : String(runError)}`;
        }
      }

      if (toolSettings.shouldOpenInVsCodeAfterEdit()) {
        try {
          await openFileInVSCode(targetFile, { reuseWindow: true });
          response += `\n\n**VS Code:** Opened ${path.basename(targetFile)}`;
        } catch (openError) {
          response += `\n\n**VS Code:** Failed to open file (${openError instanceof Error ? openError.message : String(openError)})`;
        }
      }

      let result = {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };

      // Apply output path interception for cross-platform compatibility
      const outputInterception = pathInterceptor.interceptOutput('AHK_File_Edit', result);
      if (outputInterception.success) {
        result = outputInterception.modifiedData;
        if (outputInterception.conversions.length > 0) {
          logger.debug(
            `Output path conversions applied: ${outputInterception.conversions.length} paths converted`
          );
        }
      } else {
        logger.warn(`Output path interception failed: ${outputInterception.error}`);
      }

      return result;
    } catch (error) {
      logger.error('Error in AHK_File_Edit tool:', error);

      // Check if we should create an alpha version due to failures
      const targetFile = validatedArgs?.filePath || activeFile.getActiveFile();
      if (targetFile) {
        const alphaCreated = await handleEditFailure(targetFile, error as Error);
        if (alphaCreated) {
          return {
            content: [
              {
                type: 'text',
                text: `Edit failed. Alpha version created and set as active.\n\nOriginal error: ${error instanceof Error ? error.message : String(error)}\n\nYou can now retry the edit on the alpha version.`,
              },
            ],
          };
        }
      }

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
}

/**
 * Helper function to create edit commands
 */
export class EditBuilder {
  private edits: Array<Partial<z.infer<typeof AhkEditArgsSchema>>> = [];

  replace(search: string, content: string, all = false): this {
    this.edits.push({ action: 'replace', search, content, all, regex: false, backup: true });
    return this;
  }

  insert(line: number, content: string): this {
    this.edits.push({ action: 'insert', line, content, regex: false, all: false, backup: true });
    return this;
  }

  delete(searchOrLine: string | number, endLine?: number): this {
    if (typeof searchOrLine === 'string') {
      this.edits.push({
        action: 'delete',
        search: searchOrLine,
        regex: false,
        all: false,
        backup: true,
      });
    } else {
      this.edits.push({
        action: 'delete',
        startLine: searchOrLine,
        endLine,
        regex: false,
        all: false,
        backup: true,
      });
    }
    return this;
  }

  append(content: string): this {
    this.edits.push({ action: 'append', content, regex: false, all: false, backup: true });
    return this;
  }

  prepend(content: string): this {
    this.edits.push({ action: 'prepend', content, regex: false, all: false, backup: true });
    return this;
  }

  create(content: string): this {
    this.edits.push({ action: 'create', content, regex: false, all: false, backup: false });
    return this;
  }

  getEdits(): Array<Partial<z.infer<typeof AhkEditArgsSchema>>> {
    return this.edits;
  }
}
