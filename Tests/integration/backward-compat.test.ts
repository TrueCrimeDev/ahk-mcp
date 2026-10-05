import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { AhkEditTool } from '../../src/tools/ahk-file-edit.js';
import { AhkSmartOrchestratorTool } from '../../src/tools/ahk-smart-orchestrator.js';
import type { McpToolResponse } from '../../src/types/mcp-types.js';
import fs from 'fs/promises';
import path from 'path';

type OrchestratorArgs = Parameters<AhkSmartOrchestratorTool['execute']>[0];

/** Text of the first content item, failing the test if it has none. */
function firstText(result: McpToolResponse): string {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error('Tool result has no text content');
  return text;
}

/** Whether any content item carries the (retired) orchestrator debug section. */
function hasDebugSection(result: McpToolResponse): boolean {
  return result.content.some(item => item.text?.includes('🔍 DEBUG') ?? false);
}

describe('Backward compatibility integration', () => {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const testFilePath = path.join(fixturesDir, 'test-backward-compat.ahk');
  let editTool: AhkEditTool;
  let orchestrator: AhkSmartOrchestratorTool;
  let originalContent: string;

  beforeAll(async () => {
    editTool = new AhkEditTool();
    orchestrator = new AhkSmartOrchestratorTool();
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

  it('should accept all old parameter formats without errors', async () => {
    // Old format: using "content" instead of "newContent"
    const result1 = await editTool.execute({
      action: 'replace',
      search: 'oldText',
      content: 'newText', // OLD parameter name
      filePath: testFilePath,
    });

    expect(result1.isError).toBeUndefined();
    expect(firstText(result1)).toBeTruthy();

    // Reset file
    await fs.writeFile(testFilePath, originalContent);

    // Old format: without dryRun (should default to false)
    const result2 = await editTool.execute({
      action: 'replace',
      search: 'testValue',
      content: 'newValue',
      filePath: testFilePath,
    });

    expect(result2.isError).toBeUndefined();

    // File should be modified (dryRun defaults to false)
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('newValue');
  });

  it('should work without new optional parameters (use defaults)', async () => {
    // Call the orchestrator with the original parameters only (no operation, forceRefresh,
    // validate or the retired debugMode): the defaults must apply. It needs filePath because
    // it detects files from the intent text, which names no file here.
    const result = await orchestrator.execute({
      intent: 'view TestClass',
      filePath: testFilePath,
    } as OrchestratorArgs);

    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);

    // Should NOT include debug output
    expect(hasDebugSection(result)).toBe(false);
  });

  it('should maintain JSON output structure for MCP protocol', async () => {
    // Test with old parameters
    const editResult = await editTool.execute({
      action: 'replace',
      search: 'TestClass',
      content: 'MyClass', // Old parameter
      filePath: testFilePath,
    });

    // Verify MCP protocol structure
    expect(Array.isArray(editResult.content)).toBe(true);
    expect(editResult.content.length).toBeGreaterThan(0);
    expect(editResult.content[0].type).toBe('text');
    expect(typeof editResult.content[0].text).toBe('string');

    // Test with dry-run
    await fs.writeFile(testFilePath, originalContent);

    const dryRunResult = await editTool.execute({
      action: 'replace',
      search: 'TestClass',
      newContent: 'MyClass',
      dryRun: true,
      filePath: testFilePath,
    });

    // Same structure even with new parameters
    expect(Array.isArray(dryRunResult.content)).toBe(true);
    expect(dryRunResult.content[0].type).toBe('text');
  });

  it('should handle mix of old and new parameters gracefully', async () => {
    // Mix: old "content" + new "dryRun"
    const result = await editTool.execute({
      action: 'replace',
      search: 'oldText',
      content: 'newText', // OLD
      dryRun: true, // NEW
      filePath: testFilePath,
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toContain('DRY RUN');

    // File should be unchanged (dryRun=true)
    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toBe(originalContent);
  });

  it('should not break existing error handling', async () => {
    // Invalid file: must be reported as a failed tool call
    const missingFile = await editTool.execute({
      action: 'replace',
      search: 'nonexistent',
      content: 'replacement',
      filePath: '/nonexistent/path.ahk',
    });

    expect(missingFile.isError).toBe(true);
    expect(firstText(missingFile)).toMatch(/^Error:/);

    // Missing required parameters (search and content)
    const missingParams = await editTool.execute({
      action: 'replace',
      filePath: testFilePath,
    });

    expect(missingParams.isError).toBe(true);
    expect(firstText(missingParams)).toMatch(/^Error:/);
  });

  it('should preserve all existing tool capabilities', async () => {
    // Test regex still works
    const regexResult = await editTool.execute({
      action: 'replace',
      search: 'Test\\w+',
      newContent: 'My$&', // Using capture groups
      regex: true,
      filePath: testFilePath,
    });

    expect(regexResult.isError).toBeUndefined();

    // Reset and test "all" flag
    await fs.writeFile(testFilePath, originalContent);

    const allResult = await editTool.execute({
      action: 'replace',
      search: 'DarkMode',
      newContent: 'ThemeMode',
      all: true,
      filePath: testFilePath,
    });

    expect(firstText(allResult)).toBeTruthy();

    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    const count = (fileContent.match(/ThemeMode/g) || []).length;
    expect(count).toBeGreaterThan(1);
  });

  it('should maintain backward compatible defaults', async () => {
    // When dryRun is omitted, should default to false (actual edit)
    await editTool.execute({
      action: 'replace',
      search: 'oldText',
      newContent: 'actuallyChanged',
      // dryRun omitted - should default to false
      filePath: testFilePath,
    });

    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('actuallyChanged');

    // Orchestrator without the optional settings: no debug output
    const orchestratorResult = await orchestrator.execute({
      intent: 'view TestClass',
      filePath: testFilePath,
    } as OrchestratorArgs);

    expect(orchestratorResult.isError).toBeUndefined();

    expect(hasDebugSection(orchestratorResult)).toBe(false);
  });
});
