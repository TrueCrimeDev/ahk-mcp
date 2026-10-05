import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
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

describe('Dry-run workflow integration', () => {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const testFilePath = path.join(fixturesDir, 'test-integration-dryrun.ahk');
  let editTool: AhkEditTool;
  let originalContent: string;

  beforeAll(async () => {
    editTool = new AhkEditTool();
    originalContent = await fs.readFile(
      path.join(fixturesDir, 'test-quality-improvements.ahk'),
      'utf-8'
    );
  });

  beforeEach(async () => {
    // Every test starts from a fresh working copy of the fixture
    await fs.writeFile(testFilePath, originalContent);
  });

  afterAll(async () => {
    await fs.rm(testFilePath, { force: true });
    await fs.rm(`${testFilePath}.bak`, { force: true });
  });

  it('should preview then execute batch replacement workflow', async () => {
    // Step 1: Preview with dry-run
    const preview = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'ThemeMode',
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    // Verify it's a preview
    const previewText = firstText(preview);
    expect(previewText).toContain('DRY RUN');

    // Extract expected change count
    const matchCount = previewText.match(/(\d+) occurrence/i);
    expect(matchCount).not.toBeNull();

    const expectedChanges = parseInt(matchCount![1]);
    expect(expectedChanges).toBeGreaterThan(0);

    // Verify file NOT modified yet
    let fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('DarkMode');
    expect(fileContent).not.toContain('ThemeMode');

    // Step 2: Execute actual edit (same parameters, dryRun=false)
    const actual = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'ThemeMode',
      all: true,
      dryRun: false,
      filePath: testFilePath,
    });

    // Verify it's not a preview
    const actualText = firstText(actual);
    expect(actualText).not.toContain('DRY RUN');
    expect(actualText).toMatch(/Edit Successful|✅/);

    // Step 3: Verify changes were actually made
    fileContent = await fs.readFile(testFilePath, 'utf-8');
    const actualChanges = (fileContent.match(/ThemeMode/g) || []).length;

    expect(actualChanges).toBe(expectedChanges);

    // Verify old text is gone
    expect(fileContent).not.toContain('DarkMode');
  });

  it('should allow canceling after preview (file unchanged)', async () => {
    // User previews
    const preview = await editTool.execute({
      action: 'replace',
      search: 'TestClass',
      newContent: 'DeletedClass',
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    expect(firstText(preview)).toContain('DRY RUN');

    // User decides NOT to proceed (doesn't call with dryRun=false)
    // Verify file unchanged
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('TestClass');
    expect(fileContent).not.toContain('DeletedClass');
  });

  it('should handle regex patterns in dry-run', async () => {
    const preview = await editTool.execute({
      action: 'replace',
      search: 'Test\\w+', // Regex pattern
      newContent: 'MyClass',
      regex: true,
      all: true,
      dryRun: true,
      filePath: testFilePath,
    });

    const previewText = firstText(preview);
    expect(previewText).toContain('DRY RUN');
    expect(previewText).toMatch(/\d+ occurrence/i);

    // File unchanged
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('TestClass');
  });

  it('should work with insert action in dry-run', async () => {
    const lines = originalContent.split('\n');
    const targetLine = 5;

    const preview = await editTool.execute({
      action: 'insert',
      line: targetLine,
      newContent: '; This is a test comment',
      dryRun: true,
      filePath: testFilePath,
    });

    const previewText = firstText(preview);
    expect(previewText).toContain('DRY RUN');
    expect(previewText).toContain(`Line ${targetLine}`);

    // File unchanged
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).not.toContain('This is a test comment');
    expect(fileContent.split('\n').length).toBe(lines.length);
  });
});
