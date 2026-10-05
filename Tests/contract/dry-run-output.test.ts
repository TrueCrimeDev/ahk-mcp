import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { AhkEditTool } from '../../src/tools/ahk-file-edit.js';
import type { McpToolResponse } from '../../src/types/mcp-types.js';
import fs from 'fs/promises';
import path from 'path';

/** Text of the first content item, failing the test if it has none. */
function firstText(result: McpToolResponse): string {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error('Tool result has no text content');
  return text;
}

describe('Dry-run preview format (Contract Test)', () => {
  let editTool: AhkEditTool;
  let testFilePath: string;
  let originalContent: string;

  beforeAll(async () => {
    editTool = new AhkEditTool();
    const fixturesDir = path.join(__dirname, '..', 'fixtures');
    const sourceFile = path.join(fixturesDir, 'test-quality-improvements.ahk');
    testFilePath = path.join(fixturesDir, 'test-dryrun.ahk');

    // Create test copy
    originalContent = await fs.readFile(sourceFile, 'utf-8');
    await fs.writeFile(testFilePath, originalContent);
  });

  afterAll(async () => {
    // Cleanup
    await fs.rm(testFilePath, { force: true });
  });

  it('should show "DRY RUN" marker without modifying file', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'LightMode',
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    const outputText = firstText(result);

    // Check for dry-run markers
    expect(outputText).toContain('DRY RUN');
    expect(outputText).toMatch(/no changes made/i);

    // Verify file was NOT modified
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toBe(originalContent);
    expect(fileContent).toContain('DarkMode');
  });

  it('should show occurrence count in summary', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'LightMode',
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    const outputText = firstText(result);

    // Should mention how many replacements would happen
    expect(outputText).toMatch(/would replace \d+ occurrence|\d+ occurrence.*would be replaced/i);
  });

  it('should show first 3 sample diffs when multiple changes', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'ThemeMode',
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    const outputText = firstText(result);

    // Count line number mentions (e.g., "Line 15:", "Line 23:")
    const lineMatches = outputText.match(/Line \d+:/g) ?? [];

    // The fixture has six matching lines; the preview caps its samples at three.
    expect(lineMatches).toHaveLength(3);
  });

  it('should show before/after preview for each sample', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'testValue',
      newContent: 'newValue',
      dryRun: true,
      filePath: testFilePath,
    });

    const outputText = firstText(result);

    // Should show before → after format
    expect(outputText).toMatch(/→|->|after/);
  });

  it('should work with single replacement (not just batch)', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'TestClass',
      newContent: 'MyClass',
      all: false, // Single replacement
      dryRun: true,
      filePath: testFilePath,
    });

    const outputText = firstText(result);

    expect(outputText).toContain('DRY RUN');
    expect(outputText).toMatch(/1 occurrence|first occurrence/i);

    // Verify file unchanged
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('TestClass');
  });

  it('should include file affected count in summary', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'NewMode',
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    const outputText = firstText(result);

    expect(outputText).toMatch(/1 file affected|file.*affected/i);
  });
});
