import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { createErrorResponse } from '../utils/response-helpers.js';

/**
 * CloudAHK Validation Tool
 *
 * Validates AutoHotkey code by actually executing it via CloudAHK,
 * a Docker-based AHK execution service. This catches runtime errors
 * that static analysis misses.
 */

// Environment configuration
const CLOUDAHK_URL = process.env.CLOUDAHK_URL || 'http://localhost:8000';

// Error patterns to detect in stdout
const ERROR_PATTERNS = [
  /^Error:/m,
  /^ValueError:/m,
  /^TypeError:/m,
  /^Call to nonexistent function/m,
  /^Missing/m,
  /^Invalid/m,
  /^\s+Line \d+:/m,
];

export const AhkCloudAhkValidateArgsSchema = z.object({
  code: z.string().min(1).describe('AutoHotkey code to validate by executing it'),
  version: z
    .enum(['v1', 'v2'])
    .default('v2')
    .describe('AutoHotkey version to use (v1 or v2, defaults to v2)'),
});

export type AhkCloudAhkValidateArgs = z.infer<typeof AhkCloudAhkValidateArgsSchema>;

export const ahkCloudAhkValidateToolDefinition = {
  name: 'AHK_Cloud_Validate',
  description: `Validate AutoHotkey code by actually executing it via CloudAHK.

This tool sends your AHK code to a CloudAHK server (Docker-based execution service)
and runs it to catch runtime errors that static analysis cannot detect.

**When to use:**
- After writing new AHK code to verify it runs without errors
- To test code snippets before integrating them into larger scripts
- When static analysis passes but you suspect runtime issues
- To validate syntax and runtime behavior in a sandboxed environment

**Examples:**
- Validate a simple script: \`{ "code": "MsgBox(\\"Hello\\")" }\`
- Test v1 code: \`{ "code": "#NoEnv\\nMsgBox, Hello", "version": "v1" }\`

**Note:** Scripts have a 7-second timeout. Long-running scripts will be terminated.`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'AutoHotkey code to validate by executing it',
      },
      version: {
        type: 'string',
        enum: ['v1', 'v2'],
        default: 'v2',
        description: 'AutoHotkey version to use (v1 or v2, defaults to v2)',
      },
    },
    required: ['code'],
  },
};

interface CloudAhkResponse {
  time: number | null;
  stdout: string;
  language: string;
}

interface ValidationError {
  pattern: string;
  line?: number;
  message: string;
}

interface ValidationResult {
  success: boolean;
  output: string;
  executionTime: number | null;
  timedOut: boolean;
  errors: ValidationError[];
  summary: string;
}

export class AhkCloudAhkValidateTool {
  /**
   * Parse stdout for error patterns
   */
  private parseErrors(stdout: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const lines = stdout.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(line)) {
          // Try to extract line number if present
          const lineMatch = line.match(/Line (\d+)/i);
          const lineNumber = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

          errors.push({
            pattern: pattern.source,
            line: lineNumber,
            message: line.trim(),
          });
          break; // Only match one pattern per line
        }
      }
    }

    return errors;
  }

  /**
   * Generate a human-readable summary of the validation result
   */
  private generateSummary(result: Omit<ValidationResult, 'summary'>): string {
    const parts: string[] = [];

    if (result.timedOut) {
      parts.push('⏱ Script timed out (exceeded 7 second limit).');
      parts.push('Consider breaking up long-running operations or using timers.');
    } else if (result.errors.length > 0) {
      parts.push(`✗ Script execution detected ${result.errors.length} error(s).`);
      // Show first few errors
      const maxErrors = 3;
      for (let i = 0; i < Math.min(result.errors.length, maxErrors); i++) {
        const error = result.errors[i];
        const lineInfo = error.line ? ` (Line ${error.line})` : '';
        parts.push(`  • ${error.message}${lineInfo}`);
      }
      if (result.errors.length > maxErrors) {
        parts.push(`  ... and ${result.errors.length - maxErrors} more error(s)`);
      }
    } else {
      parts.push('✓ Script executed successfully.');
      if (result.output.trim()) {
        const outputPreview = result.output.trim().slice(0, 200);
        const truncated = result.output.trim().length > 200;
        parts.push(`Output: ${outputPreview}${truncated ? '...' : ''}`);
      } else {
        parts.push('(No output produced)');
      }
    }

    if (result.executionTime !== null) {
      parts.push(`Execution time: ${result.executionTime.toFixed(3)}s`);
    }

    return parts.join('\n');
  }

  /**
   * Execute the CloudAHK validation
   */
  async execute(args: unknown): Promise<any> {
    const parsed = safeParse(args, AhkCloudAhkValidateArgsSchema, 'AHK_Cloud_Validate');
    if (!parsed.success) return parsed.error;

    const { code, version } = parsed.data;

    // Determine the language endpoint
    const language = version === 'v1' ? 'ahk' : 'ahk2';
    const url = `${CLOUDAHK_URL}/${language}/run`;

    logger.info(`CloudAHK validation: sending ${code.length} bytes to ${url}`);

    try {
      // Make the request to CloudAHK
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: code,
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`CloudAHK request failed: ${response.status} - ${errorText}`);
        return createErrorResponse(
          `CloudAHK server error: ${response.status} ${response.statusText}`,
          { details: errorText }
        );
      }

      const data: CloudAhkResponse = await response.json();

      logger.debug('CloudAHK response:', data);

      // Parse the response
      const timedOut = data.time === null;
      const errors = this.parseErrors(data.stdout);
      const success = !timedOut && errors.length === 0;

      const result: Omit<ValidationResult, 'summary'> = {
        success,
        output: data.stdout,
        executionTime: data.time,
        timedOut,
        errors,
      };

      const summary = this.generateSummary(result);

      const fullResult: ValidationResult = {
        ...result,
        summary,
      };

      logger.info(
        `CloudAHK validation complete: success=${success}, errors=${errors.length}, timedOut=${timedOut}`
      );

      return {
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: JSON.stringify(fullResult, null, 2) },
        ],
        isError: !success,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('CloudAHK validation failed:', error);

      // Provide helpful error messages
      let helpText = '';
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        helpText = `\n\nTip: Make sure CloudAHK is running at ${CLOUDAHK_URL}. You can start it with: docker run -p 8000:8000 cloudahk/cloudahk`;
      } else if (errorMessage.includes('ETIMEDOUT')) {
        helpText = `\n\nTip: CloudAHK server at ${CLOUDAHK_URL} is not responding. Check your network connection.`;
      }

      return createErrorResponse(`CloudAHK validation failed: ${errorMessage}${helpText}`);
    }
  }
}
