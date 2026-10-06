/**
 * AHK_File_Edit's alpha-version fallback: after repeated failed edits on a file it writes
 * a numbered copy and makes it the active file. The edit itself still failed, so the
 * result must stay an error, and the failure counter must live in the (isolated) config
 * directory rather than the developer's real one.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { AhkEditTool } from '../../src/tools/ahk-file-edit';

describe('AHK_File_Edit alpha-version fallback', () => {
  let tmpDir: string;
  let target: string;
  const savedAllowed = process.env.AHK_MCP_ALLOWED_DIRS;

  beforeAll(() => {
    // realpath: Windows temp paths can be 8.3 short names (RUNNER~1), tools report long ones.
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-alpha-')));
    target = path.join(tmpDir, 'script.ahk');
    fs.writeFileSync(target, 'MsgBox("hi")\n');
    process.env.AHK_MCP_ALLOWED_DIRS = tmpDir;
  });

  afterAll(() => {
    process.env.AHK_MCP_ALLOWED_DIRS = savedAllowed;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports every failed edit as an error, including the one that creates an alpha copy', async () => {
    const tool = new AhkEditTool();
    const results = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      // replace without `search` always fails
      results.push(await tool.execute({ action: 'replace', filePath: target, newContent: 'x' }));
    }

    expect(results.map(r => r.isError)).toEqual([true, true, true]);
    expect(results[2]?.content[0]?.text).toMatch(/^Error: Edit failed\. Alpha version created/);
    expect(fs.readdirSync(tmpDir).filter(name => /_a\d+\.ahk$/.test(name))).toHaveLength(1);
  });

  it('keeps the failure counter in AHK_MCP_CONFIG_DIR', () => {
    const configDir = process.env.AHK_MCP_CONFIG_DIR;
    expect(configDir).toBeTruthy();
    const state = JSON.parse(
      fs.readFileSync(path.join(configDir as string, 'alpha-versions.json'), 'utf8')
    ) as { failures: Record<string, number> };
    expect(Object.keys(state.failures).some(file => file.startsWith(tmpDir))).toBe(true);
  });
});
