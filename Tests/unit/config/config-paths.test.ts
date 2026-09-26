import { afterEach, describe, expect, it } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import { envConfig, resetEnvConfig } from '../../../src/core/env-config.js';
import {
  OPERATOR_CONFIG_FILENAME,
  getOperatorConfigPath,
} from '../../../src/core/operator-config.js';
import { getConfigPath } from '../../../src/core/config.js';

// Where the configuration files live. The 2.x config.json and the 3.0
// operator-config.json must resolve to the same directory, so an operator who
// sets AHK_MCP_CONFIG_DIR moves both.

const saved = {
  AHK_MCP_CONFIG_DIR: process.env.AHK_MCP_CONFIG_DIR,
  APPDATA: process.env.APPDATA,
};

function setEnv(name: keyof typeof saved, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv('AHK_MCP_CONFIG_DIR', saved.AHK_MCP_CONFIG_DIR);
  setEnv('APPDATA', saved.APPDATA);
  resetEnvConfig();
});

describe('configuration directory', () => {
  it('honors AHK_MCP_CONFIG_DIR, resolved to an absolute path', () => {
    setEnv('AHK_MCP_CONFIG_DIR', path.join('relative', 'cfg'));
    resetEnvConfig();
    const expected = path.resolve('relative', 'cfg');
    expect(envConfig.getConfigDir()).toBe(expected);
    expect(getOperatorConfigPath()).toBe(path.join(expected, OPERATOR_CONFIG_FILENAME));
  });

  it('ignores a blank AHK_MCP_CONFIG_DIR', () => {
    setEnv('AHK_MCP_CONFIG_DIR', '   ');
    resetEnvConfig();
    expect(path.isAbsolute(envConfig.getConfigDir())).toBe(true);
    expect(path.basename(envConfig.getConfigDir())).toBe('ahk-mcp');
  });

  if (process.platform === 'win32') {
    it('defaults to %APPDATA%\\ahk-mcp on Windows', () => {
      setEnv('AHK_MCP_CONFIG_DIR', undefined);
      const appData = path.join(os.tmpdir(), 'roaming');
      setEnv('APPDATA', appData);
      resetEnvConfig();
      expect(envConfig.getConfigDir()).toBe(path.join(appData, 'ahk-mcp'));
    });

    it('falls back to the roaming profile when APPDATA is unset', () => {
      setEnv('AHK_MCP_CONFIG_DIR', undefined);
      setEnv('APPDATA', undefined);
      resetEnvConfig();
      expect(envConfig.getConfigDir()).toBe(
        path.join(os.homedir(), 'AppData', 'Roaming', 'ahk-mcp')
      );
    });
  } else {
    it('defaults to ~/.config/ahk-mcp elsewhere', () => {
      setEnv('AHK_MCP_CONFIG_DIR', undefined);
      resetEnvConfig();
      expect(envConfig.getConfigDir()).toBe(path.join(os.homedir(), '.config', 'ahk-mcp'));
    });
  }

  it('is shared by the 2.x config.json and operator-config.json', () => {
    for (const value of [undefined, path.join(os.tmpdir(), 'ahk-mcp-shared-config')]) {
      setEnv('AHK_MCP_CONFIG_DIR', value);
      resetEnvConfig();
      expect(path.dirname(getConfigPath())).toBe(path.dirname(getOperatorConfigPath()));
    }
  });
});
