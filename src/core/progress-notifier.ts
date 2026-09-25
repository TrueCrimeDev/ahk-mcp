/**
 * MCP 2025 Progress Notifications Helper
 * @see https://spec.modelcontextprotocol.io/2024-11-05/server/utilities/progress/
 */

import logger from '../logger.js';

export interface ProgressInfo {
  /** Current progress value */
  progress: number;
  /** Total expected (optional) */
  total?: number;
  /** Human-readable status message */
  message?: string;
}

export type ProgressCallback = (info: ProgressInfo) => void | Promise<void>;

/**
 * Extracts progressToken from request _meta if provided by client
 */
export function extractProgressToken(request: unknown): string | number | undefined {
  if (
    typeof request === 'object' &&
    request !== null &&
    '_meta' in request &&
    typeof (request as Record<string, unknown>)._meta === 'object' &&
    (request as Record<string, unknown>)._meta !== null
  ) {
    const meta = (request as { _meta: Record<string, unknown> })._meta;
    const token = meta.progressToken;
    if (typeof token === 'string' || typeof token === 'number') {
      return token;
    }
  }
  return undefined;
}

export interface ProgressNotification {
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

export type ProgressSender = (notification: ProgressNotification) => Promise<void>;

/**
 * Progress notification helper for long-running operations.
 *
 * Senders are registered per progressToken by the tools/call handler, so
 * notifications reach the session that issued the request even when the
 * process serves multiple sessions.
 */
export class ProgressNotifier {
  private senders = new Map<string | number, ProgressSender>();

  /**
   * Register the sender for a client-supplied progressToken.
   * Call unregister once the request (or its task) finishes.
   */
  register(progressToken: string | number, sender: ProgressSender): void {
    this.senders.set(progressToken, sender);
  }

  unregister(progressToken: string | number): void {
    this.senders.delete(progressToken);
  }

  /**
   * Send a progress notification to the client
   */
  async notify(progressToken: string | number, info: ProgressInfo): Promise<void> {
    const send = this.senders.get(progressToken);
    if (!send) {
      logger.debug('ProgressNotifier: No sender registered for token, skipping notification');
      return;
    }

    try {
      await send({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: info.progress,
          ...(info.total !== undefined && { total: info.total }),
          ...(info.message && { message: info.message }),
        },
      });
    } catch (error) {
      // Log but don't throw - progress notifications are best-effort
      logger.debug(`ProgressNotifier: Failed to send notification: ${error}`);
    }
  }

  /**
   * Create a progress callback bound to a specific progressToken
   */
  createCallback(progressToken: string | number | undefined): ProgressCallback | undefined {
    if (!progressToken) {
      return undefined;
    }

    return async (info: ProgressInfo) => {
      await this.notify(progressToken, info);
    };
  }

  /**
   * Helper to report progress for iterating over items
   */
  async reportIteration(
    progressToken: string | number | undefined,
    current: number,
    total: number,
    message?: string
  ): Promise<void> {
    if (!progressToken) return;
    await this.notify(progressToken, { progress: current, total, message });
  }

  /**
   * Helper to report completion
   */
  async reportComplete(
    progressToken: string | number | undefined,
    message?: string
  ): Promise<void> {
    if (!progressToken) return;
    await this.notify(progressToken, { progress: 100, total: 100, message: message ?? 'Complete' });
  }

  /**
   * Helper to report indeterminate progress (no total)
   */
  async reportIndeterminate(
    progressToken: string | number | undefined,
    message: string
  ): Promise<void> {
    if (!progressToken) return;
    await this.notify(progressToken, { progress: 0, message });
  }
}

// Singleton instance
export const progressNotifier = new ProgressNotifier();

/**
 * Extract progressToken from tool args (injected by server)
 */
export function getProgressTokenFromArgs(args: unknown): string | number | undefined {
  if (typeof args === 'object' && args !== null && '_progressToken' in args) {
    const token = (args as Record<string, unknown>)._progressToken;
    if (typeof token === 'string' || typeof token === 'number') {
      return token;
    }
  }
  return undefined;
}
