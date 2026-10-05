#!/usr/bin/env node
/**
 * Additively merge a Claude Code settings patch into a settings.json file.
 *
 * Used by scripts/setup-claude-code.ps1 so that JSON edits behave the same under
 * Windows PowerShell 5.1 and PowerShell 7 (5.1's ConvertTo-Json reformats files and
 * has array quirks). Nothing the user already has is removed or replaced:
 *
 *   - arrays (permissions.allow, enabledMcpjsonServers, ...) gain missing entries
 *   - objects are merged recursively
 *   - scalars are only set when absent; a different existing value is kept and
 *     reported (pass --overwrite-env to let the patch win for keys under "env")
 *   - hooks are deduplicated by their "command" string; a new hook joins the group
 *     with the same matcher, or a new group is appended
 *
 * Usage:
 *   node scripts/merge-claude-settings.mjs --target <settings.json> --patch <patch.json>
 *        [--dry-run] [--overwrite-env] [--no-backup]
 *
 * Prints a JSON report on stdout: { target, existed, changed, dryRun, backup, changes, warnings }.
 * Exit code 0 on success, 2 on bad arguments or unreadable JSON (nothing is written).
 */
import fs from 'node:fs';
import path from 'node:path';

const LEGACY_HOOK_MARKER = 'run-after-edit.py';

function parseArgs(argv) {
  const opts = { dryRun: false, overwriteEnv: false, backup: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--patch') opts.patch = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--overwrite-env') opts.overwriteEnv = true;
    else if (arg === '--no-backup') opts.backup = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.target || !opts.patch) throw new Error('--target and --patch are required');
  return opts;
}

function readJsonObject(file, { allowMissing }) {
  if (!fs.existsSync(file)) {
    if (allowMissing) return { value: {}, existed: false };
    throw new Error(`File not found: ${file}`);
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return { value: {}, existed: true };
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}); fix or move it, then re-run`);
  }
  if (!isPlainObject(value)) throw new Error(`${file} must contain a JSON object`);
  return { value, existed: true };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mergeValue(target, patch, keyPath, ctx) {
  for (const [key, patchValue] of Object.entries(patch)) {
    const here = keyPath ? `${keyPath}.${key}` : key;
    const has = Object.prototype.hasOwnProperty.call(target, key);

    if (!keyPath && key === 'hooks' && isPlainObject(patchValue)) {
      if (!has) target.hooks = {};
      if (!isPlainObject(target.hooks)) {
        ctx.warnings.push('"hooks" is not an object; hook patch skipped');
        continue;
      }
      mergeHooks(target.hooks, patchValue, ctx);
      continue;
    }

    if (!has) {
      target[key] = clone(patchValue);
      ctx.changes.push(`set ${here}`);
      continue;
    }

    const current = target[key];
    if (Array.isArray(patchValue)) {
      if (!Array.isArray(current)) {
        ctx.warnings.push(`${here} is not an array; left unchanged`);
        continue;
      }
      for (const item of patchValue) {
        if (!current.some(existing => same(existing, item))) {
          current.push(clone(item));
          ctx.changes.push(`add ${here}: ${JSON.stringify(item)}`);
        }
      }
    } else if (isPlainObject(patchValue)) {
      if (!isPlainObject(current)) {
        ctx.warnings.push(`${here} is not an object; left unchanged`);
        continue;
      }
      mergeValue(current, patchValue, here, ctx);
    } else if (!same(current, patchValue)) {
      if (ctx.overwriteEnv && keyPath === 'env') {
        target[key] = patchValue;
        ctx.changes.push(
          `update ${here}: ${JSON.stringify(current)} -> ${JSON.stringify(patchValue)}`
        );
      } else {
        ctx.warnings.push(
          `kept existing ${here}=${JSON.stringify(current)} (setup wanted ${JSON.stringify(patchValue)})`
        );
      }
    }
  }
}

function mergeHooks(targetHooks, patchHooks, ctx) {
  for (const [event, patchGroups] of Object.entries(patchHooks)) {
    if (!Array.isArray(patchGroups)) continue;
    if (!Array.isArray(targetHooks[event])) {
      if (targetHooks[event] !== undefined) {
        ctx.warnings.push(`hooks.${event} is not an array; left unchanged`);
        continue;
      }
      targetHooks[event] = [];
    }
    const groups = targetHooks[event];
    const commandExists = command =>
      groups.some(
        group => Array.isArray(group?.hooks) && group.hooks.some(hook => hook?.command === command)
      );

    for (const patchGroup of patchGroups) {
      const matcher = patchGroup.matcher ?? '';
      for (const hook of patchGroup.hooks ?? []) {
        if (commandExists(hook.command)) continue;
        let group = groups.find(g => (g?.matcher ?? '') === matcher && Array.isArray(g.hooks));
        if (!group) {
          group = { ...clone(patchGroup), hooks: [] };
          groups.push(group);
        }
        group.hooks.push(clone(hook));
        ctx.changes.push(`add hooks.${event} [${matcher}]: ${hook.command}`);
      }
    }
  }
}

function findLegacyHooks(settings) {
  const found = [];
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof hook?.command === 'string' && hook.command.includes(LEGACY_HOOK_MARKER)) {
          found.push(`${event} [${group.matcher ?? ''}]: ${hook.command}`);
        }
      }
    }
  }
  return found;
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = path.resolve(opts.target);
  const { value: patch } = readJsonObject(path.resolve(opts.patch), { allowMissing: false });
  const { value: settings, existed } = readJsonObject(target, { allowMissing: true });

  const ctx = { changes: [], warnings: [], overwriteEnv: opts.overwriteEnv };
  mergeValue(settings, patch, '', ctx);

  for (const legacy of findLegacyHooks(settings)) {
    ctx.warnings.push(
      `legacy Python auto-run hook is still wired (${legacy}); remove it so only validate-ahk.ps1 runs`
    );
  }

  const changed = ctx.changes.length > 0;
  let backup = null;
  if (changed && !opts.dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (existed && opts.backup) {
      backup = `${target}.${timestamp()}.bak`;
      fs.copyFileSync(target, backup);
    }
    fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(
    `${JSON.stringify({ target, existed, changed, dryRun: opts.dryRun, backup, changes: ctx.changes, warnings: ctx.warnings })}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`merge-claude-settings: ${error.message}\n`);
  process.exit(2);
}
