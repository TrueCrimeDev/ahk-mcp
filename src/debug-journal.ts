import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'mcp-debug.log');
const MAX_LOG_BYTES = 512 * 1024; // 512 KB cap before trimming
const HEADER =
  '# AutoHotkey MCP debug log\n# Shows recent high-level actions to assist with troubleshooting\n';

type StatusType = 'start' | 'success' | 'error' | 'info' | string;

export interface DebugLogInfo {
  status?: StatusType;
  message?: string;
  details?: Record<string, unknown>;
}

function ensureLogFile(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, HEADER, 'utf8');
  }
}

function trimIfNeeded(): void {
  if (!fs.existsSync(LOG_FILE)) return;
  const stats = fs.statSync(LOG_FILE);
  if (stats.size <= MAX_LOG_BYTES) return;

  // When the log grows too large, archive the current file and start fresh
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = LOG_FILE.replace(/\.log$/, `-${stamp}.log`);
  try {
    fs.renameSync(LOG_FILE, archiveName);
  } catch {
    // Fall back to truncation if rename fails (e.g., permission issue)
    fs.writeFileSync(LOG_FILE, HEADER, 'utf8');
    return;
  }

  fs.writeFileSync(LOG_FILE, HEADER, 'utf8');
}

function formatDetails(details: Record<string, unknown> = {}): string {
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 8); // keep things short

  if (entries.length === 0) {
    return '';
  }

  const formatted = entries.map(([key, value]) => {
    if (typeof value === 'string') {
      const condensed = value.replace(/\s+/g, ' ');
      return `${key}="${condensed.length > 80 ? condensed.slice(0, 77) + '…' : condensed}"`;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return `${key}=${value}`;
    }

    if (Array.isArray(value)) {
      return `${key}=[${value.length} items]`;
    }

    if (value instanceof Error) {
      return `${key}="${value.message}"`;
    }

    return `${key}=[object]`;
  });

  return formatted.join(' ');
}

export function logDebugEvent(action: string, info: DebugLogInfo = {}): void {
  try {
    ensureLogFile();
    trimIfNeeded();

    const timestamp = new Date().toISOString();
    const parts: string[] = [`[${timestamp}]`, action];

    if (info.status) {
      parts.push(info.status.toUpperCase());
    }

    if (info.message) {
      parts.push(info.message.replace(/\s+/g, ' '));
    }

    const detailText = info.details ? formatDetails(info.details) : '';
    if (detailText) {
      parts.push(detailText);
    }

    const line = parts.join(' | ');
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[debug-journal] failed to write log: ${warning}\n`);
  }
}

export function logDebugError(
  action: string,
  error: unknown,
  info: Omit<DebugLogInfo, 'status'> = {}
): void {
  const message = info.message ?? (error instanceof Error ? error.message : String(error));
  const details: Record<string, unknown> = {
    ...info.details,
  };

  if (error instanceof Error && !details.error) {
    details.error = error.message;
    if (error.stack) {
      const firstLine = error.stack.split('\n')[0];
      details.stack = firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
    }
  }

  logDebugEvent(action, {
    status: 'error',
    message,
    details,
  });
}
