/**
 * MCP 2025 Elicitation Helper
 * Server-initiated user prompts for destructive operations
 *
 * Since SDK 0.5.0 lacks native elicitation support, we use a custom pattern
 * with _meta.elicitation in the response to signal that user confirmation is needed.
 */

import { randomUUID } from 'crypto';

export type ElicitationType = 'confirm' | 'choice' | 'input';

export interface ElicitationRequest {
  /** Unique identifier for this elicitation */
  id: string;
  /** Type of elicitation */
  type: ElicitationType;
  /** Message to display to user */
  message: string;
  /** Whether confirmation is required before proceeding */
  required: boolean;
  /** Optional choices for 'choice' type */
  choices?: string[];
  /** Optional default value */
  defaultValue?: string;
  /** Operation context for reference */
  context?: {
    operation: string;
    affectedItems?: number;
    filePath?: string;
  };
}

export interface ElicitationResponse {
  /** The original elicitation ID */
  elicitationId: string;
  /** User's response */
  confirmed?: boolean;
  /** Selected choice (for 'choice' type) */
  selectedChoice?: string;
  /** User input (for 'input' type) */
  userInput?: string;
}

/**
 * Create a confirmation elicitation for destructive operations
 */
export function createConfirmationElicitation(
  message: string,
  context?: ElicitationRequest['context']
): ElicitationRequest {
  return {
    id: `elicit-${randomUUID().slice(0, 8)}`,
    type: 'confirm',
    message,
    required: true,
    context,
  };
}

/**
 * Create a choice elicitation
 */
export function createChoiceElicitation(
  message: string,
  choices: string[],
  defaultValue?: string
): ElicitationRequest {
  return {
    id: `elicit-${randomUUID().slice(0, 8)}`,
    type: 'choice',
    message,
    required: true,
    choices,
    defaultValue,
  };
}

/**
 * Build a tool response that includes an elicitation request
 */
export function buildElicitationResponse(
  elicitation: ElicitationRequest,
  previewText?: string
): {
  content: Array<{ type: 'text'; text: string }>;
  _meta: {
    elicitation: ElicitationRequest;
  };
} {
  const displayText = previewText
    ? `${previewText}\n\n⚠️ ${elicitation.message}`
    : `⚠️ ${elicitation.message}`;

  return {
    content: [{ type: 'text', text: displayText }],
    _meta: {
      elicitation,
    },
  };
}

/**
 * Check if args contain elicitation confirmation
 */
export function hasElicitationConfirmation(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) {
    return false;
  }

  const typedArgs = args as Record<string, unknown>;

  // Check for explicit confirmation
  if (typedArgs.confirmDestructive === true) {
    return true;
  }

  // Check for elicitation response
  if (
    typeof typedArgs._elicitationResponse === 'object' &&
    typedArgs._elicitationResponse !== null
  ) {
    const response = typedArgs._elicitationResponse as ElicitationResponse;
    return response.confirmed === true;
  }

  return false;
}

/**
 * Create elicitation for file edit operations
 */
export function createFileEditElicitation(
  filePath: string,
  linesAffected: number,
  operation: 'delete' | 'replace' | 'overwrite'
): ElicitationRequest {
  const operationVerbs = {
    delete: 'delete',
    replace: 'modify',
    overwrite: 'overwrite',
  };

  return createConfirmationElicitation(
    `This will ${operationVerbs[operation]} ${linesAffected} line${linesAffected !== 1 ? 's' : ''} in the file. Proceed?`,
    {
      operation,
      affectedItems: linesAffected,
      filePath,
    }
  );
}

/**
 * Create elicitation for batch operations
 */
export function createBatchOperationElicitation(
  itemCount: number,
  operation: string
): ElicitationRequest {
  return createConfirmationElicitation(
    `This will ${operation} ${itemCount} item${itemCount !== 1 ? 's' : ''}. Proceed?`,
    {
      operation,
      affectedItems: itemCount,
    }
  );
}
