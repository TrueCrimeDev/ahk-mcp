import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point the server's config directory and tool settings at a throwaway directory.
 *
 * Tools under test persist state (the active file, the last edited file) to the config
 * directory, and tool-settings.json defaults to opening VS Code after every edit. Tests
 * must neither write into the developer's real ahk-mcp config nor launch an editor, so
 * each test file gets its own settings with the editor/run side effects switched off.
 *
 * Must run before any module under src/ is loaded: the settings are read once, when the
 * tool-settings singleton is created.
 *
 * @returns A function that deletes the directory again.
 */
export function isolateAhkMcpConfig(): () => void {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-mcp-test-config-'));
  const settingsPath = path.join(configDir, 'tool-settings.json');

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ autoOpenInVsCodeAfterEdit: false, autoRunAfterEdit: false }, null, 2)
  );

  process.env.AHK_MCP_CONFIG_DIR = configDir;
  process.env.AHK_MCP_SETTINGS_PATH = settingsPath;

  return () => fs.rmSync(configDir, { recursive: true, force: true });
}
