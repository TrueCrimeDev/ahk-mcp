import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import EnvironmentConfig, {
  DEFAULT_FILE_EXTENSIONS,
  ENV_VAR_GROUPS,
  EnvConfigError,
  TOOLSETS,
  describeEnvVars,
  envConfig,
  getEnvConfig,
  parseBoolean,
  parseEnv,
  resetEnvConfig,
  writeConfigWarning,
} from '../../../src/core/env-config.js';

const SRC_DIR = path.join(__dirname, '..', '..', '..', 'src');

/** Parses with a capturing sink so nothing reaches stderr. */
function parse(env: Record<string, string>, strict = false) {
  const warnings: string[] = [];
  const result = parseEnv(env, { strict, warn: message => warnings.push(message) });
  return { ...result, sink: warnings };
}

beforeEach(() => {
  resetEnvConfig();
});

describe('parseBoolean', () => {
  it.each(['1', 'true', 'TRUE', ' yes ', 'On'])('reads %p as true', value => {
    expect(parseBoolean(value)).toBe(true);
  });

  it.each(['0', 'false', 'No', 'OFF'])('reads %p as false', value => {
    expect(parseBoolean(value)).toBe(false);
  });

  it.each(['', 'maybe', '2', 'enabled', 'y'])('rejects %p', value => {
    expect(parseBoolean(value)).toBeUndefined();
  });
});

describe('parseEnv defaults', () => {
  it('parses an empty environment without issues or warnings', () => {
    const { config, issues, warnings, sources } = parse({});
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
    expect(sources).toEqual({});
    expect(config).toMatchObject({
      AHK_MCP_PORT: 3000,
      AHK_MCP_HOST: '127.0.0.1',
      AHK_MCP_TRANSPORT: 'stdio',
      AHK_MCP_LOG_LEVEL: 'warn',
      AHK_MCP_LOG_FORMAT: 'text',
      AHK_MCP_TOOL_TIMEOUT_MS: 45_000,
      AHK_MCP_TASK_TIMEOUT_MS: 600_000,
      AHK_MCP_TASK_MAX_CONCURRENT: 8,
      AHK_MCP_READ_ONLY: false,
      AHK_MCP_OBSERVABILITY: false,
      AHK_MCP_OBSERVABILITY_HOST: '127.0.0.1',
      AHK_MCP_TEXT_MIRROR: 'compact',
      AHK_MCP_DATA_MODE: 'full',
      AHK_MCP_STUDIO_EXECUTION: true,
      NODE_ENV: 'development',
    });
    expect(config.AHK_MCP_TOOLSETS).toBeUndefined();
    expect(config.AHK_MCP_AHK_PATH).toBeUndefined();
    expect(config.AHK_MCP_AUTH_TOKEN).toBeUndefined();
  });

  it('freezes the result, including lists', () => {
    const { config } = parse({ AHK_MCP_ALLOWED_DIRS: 'C:\\a;C:\\b' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.AHK_MCP_ALLOWED_DIRS)).toBe(true);
  });
});

describe('parseEnv values', () => {
  it('accepts every boolean spelling', () => {
    const { config, issues } = parse({
      AHK_MCP_READ_ONLY: 'yes',
      AHK_MCP_CHATGPT_COMPAT: 'ON',
      AHK_MCP_STUDIO_EXECUTION: 'off',
      AHK_MCP_TOOL_DISCOVERY: '1',
      AHK_MCP_LEGACY_TOOL_NAMES: 'false',
    });
    expect(issues).toEqual([]);
    expect(config.AHK_MCP_READ_ONLY).toBe(true);
    expect(config.AHK_MCP_CHATGPT_COMPAT).toBe(true);
    expect(config.AHK_MCP_STUDIO_EXECUTION).toBe(false);
    expect(config.AHK_MCP_TOOL_DISCOVERY).toBe(true);
    expect(config.AHK_MCP_LEGACY_TOOL_NAMES).toBe(false);
  });

  it('treats blank values as unset', () => {
    const { config, issues, sources } = parse({ AHK_MCP_PORT: '   ', AHK_MCP_AHK_PATH: '' });
    expect(issues).toEqual([]);
    expect(config.AHK_MCP_PORT).toBe(3000);
    expect(config.AHK_MCP_AHK_PATH).toBeUndefined();
    expect(sources).toEqual({});
  });

  it('parses integers and ports with bounds', () => {
    expect(parse({ AHK_MCP_PORT: ' 8080 ' }).config.AHK_MCP_PORT).toBe(8080);
    expect(parse({ AHK_MCP_TOOL_TIMEOUT_MS: '0' }).config.AHK_MCP_TOOL_TIMEOUT_MS).toBe(0);

    for (const [name, value] of [
      ['AHK_MCP_TOOL_TIMEOUT_MS', '12abc'],
      ['AHK_MCP_TOOL_TIMEOUT_MS', '-5'],
      ['AHK_MCP_TASK_POLL_INTERVAL_MS', '0'],
      ['AHK_MCP_PORT', '70000'],
      ['AHK_MCP_PORT', '1.5'],
    ]) {
      resetEnvConfig();
      const { issues, sink } = parse({ [name]: value });
      expect(issues).toHaveLength(1);
      expect(issues[0].variable).toBe(name);
      expect(sink.join('\n')).toContain(`${name}=${JSON.stringify(value)} is invalid`);
    }
  });

  it('falls back to the default for an invalid value', () => {
    const { config } = parse({ AHK_MCP_TOOL_TIMEOUT_MS: 'soon', AHK_MCP_PORT: 'http' });
    expect(config.AHK_MCP_TOOL_TIMEOUT_MS).toBe(45_000);
    expect(config.AHK_MCP_PORT).toBe(3000);
  });

  it('reads enumerations case-insensitively', () => {
    expect(parse({ AHK_MCP_LOG_LEVEL: 'DEBUG' }).config.AHK_MCP_LOG_LEVEL).toBe('debug');
    expect(parse({ AHK_MCP_TRANSPORT: 'Http' }).config.AHK_MCP_TRANSPORT).toBe('http');

    const invalid = parse({ AHK_MCP_LOG_LEVEL: 'verbose' });
    expect(invalid.issues.map(issue => issue.variable)).toEqual(['AHK_MCP_LOG_LEVEL']);
    expect(invalid.config.AHK_MCP_LOG_LEVEL).toBe('warn');
  });

  it('splits directory lists on semicolons and drops empty entries', () => {
    const { config } = parse({ AHK_MCP_ALLOWED_DIRS: 'C:\\Scripts; D:\\Shared ;;' });
    expect(config.AHK_MCP_ALLOWED_DIRS).toEqual(['C:\\Scripts', 'D:\\Shared']);
  });

  it('splits host and origin lists on commas', () => {
    const { config } = parse({
      AHK_MCP_ALLOWED_HOSTS: 'LocalHost, example.test',
      AHK_MCP_ALLOWED_ORIGINS: 'https://App.example.test,http://localhost:3000',
    });
    expect(config.AHK_MCP_ALLOWED_HOSTS).toEqual(['localhost', 'example.test']);
    expect(config.AHK_MCP_ALLOWED_ORIGINS).toEqual([
      'https://App.example.test',
      'http://localhost:3000',
    ]);
  });

  it('normalizes file extensions', () => {
    const { config, issues } = parse({ AHK_MCP_FILE_EXTENSIONS: 'AHK, .Txt,ahk ini' });
    expect(issues).toEqual([]);
    expect(config.AHK_MCP_FILE_EXTENSIONS).toEqual(['.ahk', '.txt', '.ini']);

    const invalid = parse({ AHK_MCP_FILE_EXTENSIONS: '.ahk,../x' });
    expect(invalid.issues.map(issue => issue.variable)).toEqual(['AHK_MCP_FILE_EXTENSIONS']);
    expect(invalid.config.AHK_MCP_FILE_EXTENSIONS).toBeUndefined();
  });

  it('returns toolsets in canonical order and expands all', () => {
    expect(parse({ AHK_MCP_TOOLSETS: 'docs, FILES' }).config.AHK_MCP_TOOLSETS).toEqual([
      'files',
      'docs',
    ]);
    expect(parse({ AHK_MCP_TOOLSETS: 'all' }).config.AHK_MCP_TOOLSETS).toEqual([...TOOLSETS]);
    expect(parse({ AHK_MCP_TOOLSETS: 'uia;*' }).config.AHK_MCP_TOOLSETS).toEqual([...TOOLSETS]);
  });

  it('keeps only recognized toolsets when a name is unknown (fails closed)', () => {
    const { config, issues, sink } = parse({ AHK_MCP_TOOLSETS: 'files,analyis,docs' });
    expect(config.AHK_MCP_TOOLSETS).toEqual(['files', 'docs']);
    expect(issues[0].message).toContain("unknown toolset 'analyis'");
    expect(sink.join('\n')).toContain('using files, docs');
  });

  it('turns read-only mode on for an unrecognized value (fails closed)', () => {
    const { config, issues } = parse({ AHK_MCP_READ_ONLY: 'maybe' });
    expect(config.AHK_MCP_READ_ONLY).toBe(true);
    expect(issues.map(issue => issue.variable)).toEqual(['AHK_MCP_READ_ONLY']);
  });

  it('validates URLs', () => {
    const { config, issues } = parse({ AHK_MCP_OTEL_ENDPOINT: 'not a url' });
    expect(config.AHK_MCP_OTEL_ENDPOINT).toBeUndefined();
    expect(issues.map(issue => issue.variable)).toEqual(['AHK_MCP_OTEL_ENDPOINT']);
    expect(
      parse({ AHK_MCP_OTEL_ENDPOINT: 'http://localhost:4318/v1/traces' }).config
        .AHK_MCP_OTEL_ENDPOINT
    ).toBe('http://localhost:4318/v1/traces');
  });

  it('maps NODE_ENV like 2.x: anything but production or test is development', () => {
    expect(parse({ NODE_ENV: 'Production' }).config.NODE_ENV).toBe('production');
    expect(parse({ NODE_ENV: 'test' }).config.NODE_ENV).toBe('test');
    const staging = parse({ NODE_ENV: 'staging' });
    expect(staging.config.NODE_ENV).toBe('development');
    expect(staging.issues).toEqual([]);
  });

  it('throws every issue at once in strict mode', () => {
    let caught: unknown;
    try {
      parse({ PORT: 'eighty', AHK_MCP_LOG_LEVEL: 'loud' }, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvConfigError);
    const error = caught as EnvConfigError;
    expect(error.issues.map(issue => issue.source).sort()).toEqual(['AHK_MCP_LOG_LEVEL', 'PORT']);
    expect(error.message).toContain('PORT:');
  });

  it('does not throw in strict mode when everything is valid', () => {
    expect(() => parse({ AHK_MCP_PORT: '3001' }, true)).not.toThrow();
  });
});

describe('deprecated aliases', () => {
  it('maps an old name to its replacement and says so once', () => {
    const { config, sources, sink } = parse({ PORT: '8081' });
    expect(config.AHK_MCP_PORT).toBe(8081);
    expect(sources.AHK_MCP_PORT).toBe('PORT');
    expect(sink).toEqual(['PORT is deprecated; use AHK_MCP_PORT instead.']);
  });

  it('prefers the current name over an alias and reports the alias as ignored', () => {
    const { config, sources, sink } = parse({ AHK_MCP_PORT: '4000', PORT: '5000' });
    expect(config.AHK_MCP_PORT).toBe(4000);
    expect(sources.AHK_MCP_PORT).toBe('AHK_MCP_PORT');
    expect(sink).toEqual([
      'PORT is deprecated and ignored because AHK_MCP_PORT is set; use AHK_MCP_PORT.',
    ]);
  });

  it('applies aliases in their declared precedence order', () => {
    const all = parse({
      AHK_BINARY: 'C:\\c.exe',
      AHK_PATH: 'C:\\b.exe',
      AHK_PATH_WIN: 'C:\\a.exe',
    });
    expect(all.config.AHK_MCP_AHK_PATH).toBe('C:\\a.exe');
    expect(all.sources.AHK_MCP_AHK_PATH).toBe('AHK_PATH_WIN');
    expect(all.sink).toHaveLength(3);

    resetEnvConfig();
    const two = parse({ AHK_BINARY: 'C:\\c.exe', AHK_PATH: 'C:\\b.exe' });
    expect(two.config.AHK_MCP_AHK_PATH).toBe('C:\\b.exe');
  });

  it('maps every documented alias', () => {
    const cases: Array<[string, string, string, unknown]> = [
      ['LOG_LEVEL', 'debug', 'AHK_MCP_LOG_LEVEL', 'debug'],
      ['AHK_THQBY_LSP_SERVER', 'C:\\lsp\\server.js', 'AHK_MCP_THQBY_PATH', 'C:\\lsp\\server.js'],
      ['AHK_DAP_PORT', '9100', 'AHK_MCP_DAP_PORT', 9100],
      ['AHK_MCP_HTTP_HOST', '0.0.0.0', 'AHK_MCP_HOST', '0.0.0.0'],
      ['AHK_MCP_SCRIPT_DIR_WIN', 'C:\\Work', 'AHK_MCP_SCRIPT_DIR', 'C:\\Work'],
      ['AHK_MCP_OBSERVABILITY_ENABLED', 'true', 'AHK_MCP_OBSERVABILITY', true],
      ['AHK_CHECK_CACHE_SIZE', '16', 'AHK_MCP_CHECK_CACHE_SIZE', 16],
      ['AHK_MCP_DEFAULT_TASK_TTL_MS', '1000', 'AHK_MCP_TASK_DEFAULT_TTL_MS', 1000],
      ['AHK_MCP_MAX_TASK_TTL_MS', '2000', 'AHK_MCP_TASK_MAX_TTL_MS', 2000],
      ['AHK_MCP_LIGHT', '1', 'AHK_MCP_DATA_MODE', 'light'],
      ['AHK_MCP_LIGHT', 'off', 'AHK_MCP_DATA_MODE', 'full'],
    ];
    for (const [alias, value, target, expected] of cases) {
      resetEnvConfig();
      const { config, sources, issues } = parse({ [alias]: value });
      expect(issues).toEqual([]);
      expect(config[target as keyof typeof config]).toEqual(expected);
      expect(sources[target as keyof typeof sources]).toBe(alias);
    }
  });

  it('reports an invalid alias value under the alias name', () => {
    const { issues, sink } = parse({ AHK_MCP_LIGHT: 'sometimes' });
    expect(issues).toEqual([
      expect.objectContaining({ variable: 'AHK_MCP_DATA_MODE', source: 'AHK_MCP_LIGHT' }),
    ]);
    expect(sink.some(message => message.startsWith('AHK_MCP_LIGHT="sometimes" is invalid'))).toBe(
      true
    );
  });

  it('keeps 2.x-only variables readable and says what replaces them', () => {
    const { config, sink } = parse({ AHK_MCP_UNRESTRICTED_PATHS: '1', AHK_DAP_ENABLED: 'on' });
    expect(config.AHK_MCP_UNRESTRICTED_PATHS).toBe(true);
    expect(config.AHK_DAP_ENABLED).toBe(true);
    expect(sink).toEqual([
      'AHK_DAP_ENABLED is deprecated. Removed in 3.0. Run the `ahk-mcp-dap` command instead.',
      'AHK_MCP_UNRESTRICTED_PATHS is deprecated. Removed in 3.0. List the directories in `AHK_MCP_ALLOWED_DIRS` instead.',
    ]);
  });

  it('declares each alias once, and never as a current name', () => {
    const variables = describeEnvVars();
    const names = new Set(variables.map(variable => variable.name));
    const aliases = variables.flatMap(variable => variable.aliases.map(alias => alias.name));
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) expect(names.has(alias as never)).toBe(false);
  });
});

describe('once-only warnings', () => {
  it('emits each distinct warning once per process', () => {
    const env = { PORT: '8082', AHK_MCP_TOOLSET: 'files', AHK_MCP_PORT_NUMBER: '1' };
    const first = parse(env);
    expect(first.warnings).toHaveLength(3);
    expect(first.sink).toEqual(first.warnings);

    const second = parse(env);
    expect(second.warnings).toEqual([]);
    expect(second.sink).toEqual([]);
    expect(second.config.AHK_MCP_PORT).toBe(8082);

    resetEnvConfig();
    expect(parse(env).warnings).toHaveLength(3);
  });

  it('reports an invalid value once even if it is parsed again', () => {
    expect(parse({ AHK_MCP_PORT: 'x' }).sink).toHaveLength(1);
    expect(parse({ AHK_MCP_PORT: 'x' }).sink).toHaveLength(0);
  });

  describe('default sink', () => {
    let stderr: ReturnType<typeof jest.spyOn>;
    let stdout: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderr.mockRestore();
      stdout.mockRestore();
    });

    it('writes to stderr, never stdout', () => {
      parseEnv({ PORT: '8083' });
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0][0])).toMatch(
        /WARN: \[config\] PORT is deprecated; use AHK_MCP_PORT instead\.\n$/
      );
    });

    it('writes JSON lines when the log format is json', () => {
      parseEnv({ PORT: '8084', AHK_MCP_LOG_FORMAT: 'json' });
      const line = JSON.parse(String(stderr.mock.calls[0][0]));
      expect(line).toMatchObject({
        level: 'WARN',
        message: 'PORT is deprecated; use AHK_MCP_PORT instead.',
      });
    });

    it('stays quiet when the log level is error', () => {
      const result = parseEnv({ PORT: '8085', AHK_MCP_LOG_LEVEL: 'error' });
      expect(result.warnings).toHaveLength(1);
      expect(stderr).not.toHaveBeenCalled();
    });

    it('is also used by writeConfigWarning', () => {
      const saved = process.env.AHK_MCP_LOG_LEVEL;
      process.env.AHK_MCP_LOG_LEVEL = 'warn';
      try {
        resetEnvConfig();
        writeConfigWarning('operator-config.json is not used');
        expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
          '[config] operator-config.json is not used'
        );
      } finally {
        if (saved === undefined) delete process.env.AHK_MCP_LOG_LEVEL;
        else process.env.AHK_MCP_LOG_LEVEL = saved;
        resetEnvConfig();
      }
    });
  });
});

describe('unknown keys', () => {
  it('warns about an unknown AHK_MCP_ key and suggests the closest name', () => {
    const { sink } = parse({ AHK_MCP_TOOLSET: 'files' });
    expect(sink).toEqual([
      'AHK_MCP_TOOLSET is not a known setting and is ignored (did you mean AHK_MCP_TOOLSETS?).',
    ]);
  });

  it('omits the suggestion when nothing is close', () => {
    const { sink } = parse({ AHK_MCP_QQQQQQQQQQQQQQQQ: '1' });
    expect(sink).toEqual(['AHK_MCP_QQQQQQQQQQQQQQQQ is not a known setting and is ignored.']);
  });

  it('does not report aliases, deprecated names or non-AHK_MCP keys', () => {
    const { sink } = parse({
      AHK_MCP_LIGHT: '1',
      AHK_MCP_HTTP_HOST: '127.0.0.1',
      AHK_MCP_TRACING_ENABLED: 'false',
      AHK_SMOKE_DIR: 'x',
      SOME_OTHER_SETTING: 'x',
    });
    expect(sink.filter(message => message.includes('not a known setting'))).toEqual([]);
  });

  it('never echoes values of unknown keys or secrets', () => {
    const secret = 'sk-do-not-print-0123456789abcdef';
    const { warnings, issues } = parse({
      AHK_MCP_AUTH_TOKN: secret,
      AHK_MCP_AUTH_TOKEN: secret,
      AHK_MCP_DAP_TOKEN: secret,
      AHK_MCP_PORT: 'bad',
    });
    const text = JSON.stringify({ warnings, issues });
    expect(text).toContain('AHK_MCP_AUTH_TOKN');
    expect(text).not.toContain(secret);
  });
});

describe('process environment cache', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    resetEnvConfig();
  });

  it('parses process.env once and keeps the result until reset', () => {
    process.env.AHK_MCP_PORT = '4100';
    const first = getEnvConfig();
    expect(first.AHK_MCP_PORT).toBe(4100);

    process.env.AHK_MCP_PORT = '4200';
    expect(getEnvConfig()).toBe(first);
    expect(envConfig.getPort()).toBe(4100);

    resetEnvConfig();
    expect(getEnvConfig().AHK_MCP_PORT).toBe(4200);
  });
});

describe('2.x accessors', () => {
  const view = (env: Record<string, string>) =>
    new EnvironmentConfig(() => parseEnv(env, { warn: () => undefined }).config);

  it('keep their 2.x names and defaults', () => {
    const config = view({});
    expect(config.getLogLevel()).toBe('warn');
    expect(config.getPort()).toBe(3000);
    expect(config.getToolTimeoutMs()).toBe(45_000);
    expect(config.getTaskPollIntervalMs()).toBe(2000);
    expect(config.getTaskTimeoutMs()).toBe(600_000);
    expect(config.getActiveFilePath()).toBeUndefined();
    expect(config.getScriptDir()).toBeUndefined();
    expect(config.getDataMode()).toBe('full');
    expect(config.isLightMode()).toBe(false);
    expect(config.getNodeEnv()).toBe('development');
    expect(config.isDevelopment()).toBe(true);
    expect(config.getSettingsPath()).toBe(path.join(config.getConfigDir(), 'settings.json'));
  });

  it('read the new names and the deprecated aliases', () => {
    const config = view({
      LOG_LEVEL: 'info',
      PORT: '3100',
      AHK_MCP_TOOL_TIMEOUT_MS: '0',
      AHK_MCP_TASK_POLL_INTERVAL_MS: '500',
      AHK_MCP_TASK_TIMEOUT_MS: '0',
      AHK_ACTIVE_FILE: 'C:\\Work\\a.ahk',
      AHK_MCP_SCRIPT_DIR_WIN: 'C:\\Work',
      AHK_MCP_LIGHT: '1',
      AHK_MCP_SETTINGS_PATH: 'C:\\cfg\\tool-settings.json',
      NODE_ENV: 'production',
    });
    expect(config.getLogLevel()).toBe('info');
    expect(config.getPort()).toBe(3100);
    expect(config.getToolTimeoutMs()).toBe(0);
    expect(config.getTaskPollIntervalMs()).toBe(500);
    expect(config.getTaskTimeoutMs()).toBe(0);
    expect(config.getActiveFilePath()).toBe('C:\\Work\\a.ahk');
    expect(config.getScriptDir()).toBe('C:\\Work');
    expect(config.isLightMode()).toBe(true);
    expect(config.getSettingsPath()).toBe('C:\\cfg\\tool-settings.json');
    expect(config.isProduction()).toBe(true);
  });

  it('select HTTP only on an explicit request', () => {
    expect(view({ PORT: '3000' }).useSSEMode()).toBe(false);
    expect(view({ AHK_MCP_TRANSPORT: 'http' }).useSSEMode()).toBe(true);
    expect(view({ AHK_MCP_TRANSPORT: 'http' }).getTransport()).toBe('http');

    const argv = process.argv;
    process.argv = [...argv, '--http'];
    try {
      expect(view({}).useSSEMode()).toBe(true);
    } finally {
      process.argv = argv;
    }
  });

  it('resolve the configured config directory', () => {
    expect(view({ AHK_MCP_CONFIG_DIR: 'relative-cfg' }).getConfigDir()).toBe(
      path.resolve('relative-cfg')
    );
  });

  it('never include secrets in getAllConfig', () => {
    const secret = 'sk-do-not-print-0123456789abcdef';
    const snapshot = JSON.stringify(view({ AHK_MCP_AUTH_TOKEN: secret }).getAllConfig());
    expect(snapshot).not.toContain(secret);
  });

  it('are available on the shared envConfig instance', () => {
    expect(envConfig.getNodeEnv()).toBe('test');
    expect(envConfig.getLogLevel()).toBe('error');
  });
});

describe('declarations', () => {
  const variables = describeEnvVars();

  it('document every variable', () => {
    const groups = new Set(ENV_VAR_GROUPS.map(group => group.id));
    for (const variable of variables) {
      expect(groups.has(variable.group)).toBe(true);
      expect(variable.description).toMatch(/\.$/);
      expect(variable.kind.length).toBeGreaterThan(0);
    }
  });

  it('namespace every current variable except standard ones', () => {
    for (const variable of variables) {
      if (variable.deprecated || variable.name === 'NODE_ENV') continue;
      expect(variable.name).toMatch(/^AHK_MCP_[A-Z0-9_]+$/);
    }
  });

  it('report the documented defaults', () => {
    const byName = new Map(variables.map(variable => [variable.name, variable]));
    expect(byName.get('AHK_MCP_PORT')?.defaultValue).toBe('3000');
    expect(byName.get('AHK_MCP_OBSERVABILITY')?.defaultValue).toBe('false');
    expect(byName.get('AHK_MCP_AUTH_TOKEN')?.defaultValue).toBeUndefined();
    expect(byName.get('AHK_MCP_AUTH_TOKEN')?.secret).toBe(true);
    expect(byName.get('AHK_MCP_FILE_EXTENSIONS')?.defaultText).toBe(
      DEFAULT_FILE_EXTENSIONS.map(extension => `\`${extension}\``).join(', ')
    );
  });

  it('cover every configuration variable the source reads', () => {
    const known = new Set(
      variables.flatMap(variable => [variable.name, ...variable.aliases.map(alias => alias.name)])
    );
    const read = new Set<string>();
    const patterns = [
      /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
      /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
      /getPositiveIntEnv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    ];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) read.add(match[1]);
          }
        }
      }
    };
    visit(SRC_DIR);

    // Platform facts, not operator configuration.
    const platform = new Set(['APPDATA', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'ProgramFiles']);
    const undeclared = [...read].filter(name => !platform.has(name) && !known.has(name)).sort();
    expect(undeclared).toEqual([]);
    expect(read.size).toBeGreaterThan(20);
  });
});
