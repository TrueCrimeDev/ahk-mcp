// Multi-port scan for AHK debug sessions via MCP debug agent tool
// Usage: node scripts/scan-debug.js

import { AhkDebugAgentTool } from '../dist/tools/ahk-debug-agent.js';

const tool = new AhkDebugAgentTool();

const args = {
  mode: 'scan',
  scanTimeoutMs: parseInt(process.env.SCAN_TIMEOUT_MS || '10000', 10),
  listenHost: process.env.LISTEN_HOST || '127.0.0.1'
  // Ports not specified to use default pool [9002..9006]
};

try {
  const res = await tool.execute(args);
  const text = res?.content?.[0]?.text || JSON.stringify(res, null, 2);
  console.log(text);
  process.exit(0);
} catch (err) {
  console.error('Scan error:', err);
  process.exit(1);
}


