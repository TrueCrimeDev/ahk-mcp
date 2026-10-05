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

describe('AHK_File_Edit parameter aliasing (Contract Test)', () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'test-quality-improvements.ahk');
  const testFilePath = path.join(__dirname, '..', 'fixtures', 'test-param-aliases.ahk');
  let editTool: AhkEditTool;
  let originalContent: string;

  beforeAll(async () => {
    editTool = new AhkEditTool();
    originalContent = await fs.readFile(fixturePath, 'utf-8');
  });

  beforeEach(async () => {
    // Every test edits a fresh working copy of the fixture
    await fs.writeFile(testFilePath, originalContent);
  });

  afterAll(async () => {
    await fs.rm(testFilePath, { force: true });
    await fs.rm(`${testFilePath}.bak`, { force: true });
  });

  it('should accept deprecated "content" parameter', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'oldText',
      content: 'newText', // Old parameter name
      filePath: testFilePath,
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toContain('Edit Successful');
  });

  it('should accept new "newContent" parameter', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'oldText',
      newContent: 'replacementText', // New parameter name
      filePath: testFilePath,
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toContain('Edit Successful');
  });

  it('should prefer "newContent" over "content" when both provided', async () => {
    await editTool.execute({
      action: 'replace',
      search: 'oldText',
      content: 'WRONG',
      newContent: 'CORRECT',
      filePath: testFilePath,
    });

    const fileContent = await fs.readFile(testFilePath, 'utf-8');
    expect(fileContent).toContain('CORRECT');
    expect(fileContent).not.toContain('WRONG');
  });

  it('should show deprecation warning when using "content"', async () => {
    const result = await editTool.execute({
      action: 'replace',
      search: 'testValue',
      content: 'newValue', // Old parameter
      filePath: testFilePath,
    });

    expect(firstText(result)).toMatch(/deprecated|use.*newContent/i);
  });
});
