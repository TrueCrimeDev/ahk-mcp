// Persistent multi-port listener for AHK debug sessions via MCP debug agent tool
// Usage: node scripts/start-debug.js
// Optional env:
//   LISTEN_HOST=127.0.0.1
//   PORTS=9002,9003,9004,9005,9006
//   FORWARD_HOST=127.0.0.1
//   FORWARD_PORT=9002
//   MAX_EVENTS=500

import { AhkDebugAgentTool } from '../dist/tools/ahk-debug-agent.js';

const tool = new AhkDebugAgentTool();

const ports = process.env.PORTS
  ? process.env.PORTS.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n))
  : [9002, 9003, 9004, 9005, 9006];

const args = {
  mode: 'start',
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  listenPorts: ports,
  forwardHost: process.env.FORWARD_HOST || undefined,
  forwardPort: process.env.FORWARD_PORT ? parseInt(process.env.FORWARD_PORT, 10) : undefined,
  maxEvents: process.env.MAX_EVENTS ? parseInt(process.env.MAX_EVENTS, 10) : 500
};

(async () => {
  try {
    const res = await tool.execute(args);
    const text = res?.content?.[0]?.text || JSON.stringify(res, null, 2);
    console.log(text);
    console.log('AHK debug listener is active. Press Ctrl+C to stop.');
    // Keep the process alive so the TCP servers remain active
    setInterval(() => {}, 1 << 30);
  } catch (err) {
    console.error('Start error:', err);
    process.exit(1);
  }
})();


