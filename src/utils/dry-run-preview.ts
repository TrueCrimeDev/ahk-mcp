/**
 * Sample diff showing before/after for a single change
 */
export interface DryRunSample {
  lineNumber: number;
  before: string;
  after: string;
}

/**
 * Summary of what a dry-run operation would do
 */
export interface DryRunPreview {
  summary: {
    filesAffected: number;
    totalChanges: number;
    operationType: string;
    characterDiff?: {
      added: number;
      removed: number;
    };
  };
  samples: DryRunSample[];
  warnings: string[];
}

/**
 * Options for generating dry-run previews
 */
export interface DryRunOptions {
  regex?: boolean;
  all?: boolean;
  maxSamples?: number;
}

/**
 * Generates previews of file changes without modifying files
 */
export class DryRunPreviewGenerator {
  private maxSamples: number;

  constructor(maxSamples: number = 3) {
    this.maxSamples = maxSamples;
  }

  /**
   * Generate a preview for a replace operation
   */
  generatePreview(
    content: string,
    search: string | RegExp,
    replacement: string,
    options: DryRunOptions = {}
  ): DryRunPreview {
    const lines = content.split('\n');
    const samples: DryRunSample[] = [];
    let totalChanges = 0;
    let addedChars = 0;
    let removedChars = 0;

    const searchPattern = options.regex
      ? typeof search === 'string'
        ? new RegExp(search, options.all ? 'g' : '')
        : search
      : search;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let matched = false;
      let modifiedLine = line;
      // Occurrences replaced on this line; a line can hold more than one when `all` is set.
      let occurrences = 0;

      if (options.regex && searchPattern instanceof RegExp) {
        matched = searchPattern.test(line);
        if (matched) {
          modifiedLine = line.replace(searchPattern, replacement);
          occurrences = searchPattern.global ? (line.match(searchPattern)?.length ?? 1) : 1;
        }
      } else {
        const searchStr = typeof search === 'string' ? search : search.toString();
        matched = line.includes(searchStr);
        if (matched) {
          if (options.all) {
            const parts = line.split(searchStr);
            occurrences = parts.length - 1;
            modifiedLine = parts.join(replacement);
          } else {
            occurrences = 1;
            modifiedLine = line.replace(searchStr, replacement);
          }
        }
      }

      if (matched) {
        totalChanges += occurrences;

        // Calculate character difference
        addedChars += modifiedLine.length;
        removedChars += line.length;

        // Add to samples if we haven't reached max
        if (samples.length < this.maxSamples) {
          samples.push({
            lineNumber: i + 1,
            before: line,
            after: modifiedLine,
          });
        }

        // If not replacing all, stop after first match
        if (!options.all) {
          break;
        }
      }
    }

    return {
      summary: {
        filesAffected: 1,
        totalChanges,
        operationType: 'replace',
        characterDiff: {
          added: addedChars,
          removed: removedChars,
        },
      },
      samples,
      warnings: [],
    };
  }

  /**
   * Generate preview for insert operation
   */
  generateInsertPreview(content: string, lineNumber: number, insertContent: string): DryRunPreview {
    const lines = content.split('\n');

    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return {
        summary: {
          filesAffected: 1,
          totalChanges: 0,
          operationType: 'insert',
        },
        samples: [],
        warnings: [`Invalid line number ${lineNumber} (file has ${lines.length} lines)`],
      };
    }

    return {
      summary: {
        filesAffected: 1,
        totalChanges: 1,
        operationType: 'insert',
        characterDiff: {
          added: insertContent.length,
          removed: 0,
        },
      },
      samples: [
        {
          lineNumber,
          before: lineNumber <= lines.length ? lines[lineNumber - 1] : '(end of file)',
          after: `${insertContent}\n${lineNumber <= lines.length ? lines[lineNumber - 1] : ''}`,
        },
      ],
      warnings: [],
    };
  }

  /**
   * Generate preview for delete operation
   */
  generateDeletePreview(content: string, startLine: number, endLine?: number): DryRunPreview {
    const lines = content.split('\n');
    const actualEndLine = endLine || startLine;

    if (startLine < 1 || startLine > lines.length) {
      return {
        summary: {
          filesAffected: 1,
          totalChanges: 0,
          operationType: 'delete',
        },
        samples: [],
        warnings: [`Invalid start line ${startLine} (file has ${lines.length} lines)`],
      };
    }

    const deletedLines = lines.slice(startLine - 1, actualEndLine);
    const totalCharsRemoved = deletedLines.reduce((sum, line) => sum + line.length, 0);

    return {
      summary: {
        filesAffected: 1,
        totalChanges: deletedLines.length,
        operationType: 'delete',
        characterDiff: {
          added: 0,
          removed: totalCharsRemoved,
        },
      },
      samples: deletedLines.slice(0, this.maxSamples).map((line, idx) => ({
        lineNumber: startLine + idx,
        before: line,
        after: '(deleted)',
      })),
      warnings: [],
    };
  }

  /**
   * Format a preview as human-readable text
   */
  formatPreview(preview: DryRunPreview, filePath: string): string {
    let output = '[DRY RUN] **DRY RUN - No changes made**\n\n';
    output += `**File:** ${filePath}\n`;

    // Operation description
    const { totalChanges, operationType } = preview.summary;

    if (operationType === 'replace') {
      if (totalChanges === 0) {
        output += `**Operation:** Replace (no matches found)\n\n`;
        output += `[WARN] **DRY RUN**: No changes would be made - pattern not found in file`;
        return output;
      } else if (totalChanges === 1) {
        output += `**Operation:** Replace first occurrence\n\n`;
      } else {
        output += `**Operation:** Replace all occurrences\n\n`;
      }
    } else {
      output += `**Operation:** ${operationType}\n\n`;
    }

    // Show samples
    if (preview.samples.length > 0) {
      const showingNote =
        totalChanges > preview.samples.length
          ? ` (showing first ${preview.samples.length} of ${totalChanges})`
          : '';

      output += `**Would change**${showingNote}:\n`;

      for (let i = 0; i < preview.samples.length; i++) {
        const sample = preview.samples[i];
        output += `${i + 1}. Line ${sample.lineNumber}:  ${sample.before}  →  ${sample.after}\n`;
      }
    }

    // Summary section
    output += `\n**Summary:**\n`;
    output += `- ${preview.summary.filesAffected} file affected\n`;
    output += `- ${totalChanges} occurrence(s) would be ${operationType === 'delete' ? 'deleted' : 'replaced'}\n`;

    // Character diff if available
    if (preview.summary.characterDiff) {
      const { added, removed } = preview.summary.characterDiff;
      if (added !== removed) {
        output += `- Characters changed: +${added} -${removed}\n`;
      }
    }

    // Warnings
    if (preview.warnings.length > 0) {
      output += `\n[WARN] **Warnings:**\n`;
      for (const warning of preview.warnings) {
        output += `- ${warning}\n`;
      }
    }

    output += `\n[WARN] **DRY RUN**: File was NOT modified`;

    return output;
  }
}

/**
 * Helper to create a preview generator with default settings
 */
export function createPreviewGenerator(maxSamples?: number): DryRunPreviewGenerator {
  return new DryRunPreviewGenerator(maxSamples);
}
