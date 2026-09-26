import { findAutoHotkey } from './ahk-runtime.js';

/**
 * Global setup for `npm run test:ahk`. Suites skip themselves when AutoHotkey
 * is missing, which is right on a developer machine but would let a broken CI
 * install pass silently. AHK_TEST_REQUIRE_RUNTIME=1 (set by the CI job) turns
 * a missing runtime into a hard failure.
 */
export default async function globalSetup(): Promise<void> {
  const ahk = findAutoHotkey();
  if (ahk) {
    process.stderr.write(`[test:ahk] AutoHotkey: ${ahk}\n`);
    return;
  }
  if (process.env.AHK_TEST_REQUIRE_RUNTIME === '1') {
    throw new Error(
      'AHK_TEST_REQUIRE_RUNTIME=1 but no AutoHotkey v2 executable was found. ' +
        'Set AHK_MCP_AHK_PATH to AutoHotkey64.exe.'
    );
  }
  process.stderr.write('[test:ahk] AutoHotkey v2 not found; Tests/ahk suites will skip.\n');
}
