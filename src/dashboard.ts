/**
 * MCP Server Monitoring Dashboard
 *
 * Serves a single-page monitoring dashboard and JSON API endpoints.
 * Shows tool usage, active sessions, and live activity logs.
 */

import type { Express, Request, Response } from 'express';
import { tracer } from './core/tracing.js';
import { toolAnalytics } from './core/tool-analytics.js';

type SessionEntry = {
  protocol: string;
  createdAt: number;
  lastActivity: number;
};

export function mountDashboard(app: Express, activeSessions: Map<string, SessionEntry>): void {
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard');
  });

  // JSON API endpoints
  app.get('/dashboard/api/sessions', (_req: Request, res: Response) => {
    const sessions = Array.from(activeSessions.entries()).map(([id, s]) => ({
      id: id.slice(0, 8) + '...',
      protocol: s.protocol,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
      idleMs: Date.now() - s.lastActivity,
    }));
    res.json({ count: activeSessions.size, sessions });
  });

  app.get('/dashboard/api/tools', (_req: Request, res: Response) => {
    res.json(toolAnalytics.getSummary());
  });

  app.get('/dashboard/api/tools/all', (_req: Request, res: Response) => {
    const allStats = toolAnalytics.getAllStats();
    const tools = Array.from(allStats.entries()).map(([name, stats]) => ({
      name,
      totalCalls: stats.totalCalls,
      successfulCalls: stats.successfulCalls,
      failedCalls: stats.failedCalls,
      successRate:
        stats.totalCalls > 0 ? ((stats.successfulCalls / stats.totalCalls) * 100).toFixed(1) : '0',
      averageDuration: Math.round(stats.averageDuration),
      lastUsed: new Date(stats.lastUsed).toISOString(),
    }));
    tools.sort((a, b) => b.totalCalls - a.totalCalls);
    res.json({ tools });
  });

  app.get('/dashboard/api/activity', (_req: Request, res: Response) => {
    const recentMetrics = toolAnalytics.getRecentMetrics(50);
    const activity = recentMetrics.reverse().map(m => ({
      tool: m.toolName,
      success: m.success,
      duration: m.duration,
      time: new Date(m.timestamp).toISOString(),
      error: m.errorMessage || null,
      traceId: m.traceId || null,
      result: m.resultPreview || null,
    }));
    res.json({ activity });
  });

  app.get('/dashboard/api/stats', (_req: Request, res: Response) => {
    const tracingStats = tracer.getStats();
    const mem = process.memoryUsage();
    res.json({
      uptime: process.uptime(),
      sessions: activeSessions.size,
      tracing: tracingStats,
      memory: {
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMB: (mem.rss / 1024 / 1024).toFixed(1),
      },
    });
  });

  // HTML Dashboard
  app.get('/dashboard', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AHK MCP Monitor</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg); color: var(--text); padding: 16px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  h1 .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green); display: inline-block; }
  h1 .dot.offline { background: var(--red); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
  .stat { font-size: 28px; font-weight: 600; }
  .stat-label { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .stat-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  tr:hover { background: rgba(88,166,255,0.04); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .badge-ok { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-err { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-proto { background: rgba(88,166,255,0.15); color: var(--accent); }
  .activity-list { max-height: 400px; overflow-y: auto; }
  .activity-item { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
  .activity-item:hover { background: rgba(88,166,255,0.04); }
  .activity-row { display: flex; gap: 10px; align-items: center; }
  .activity-item .time { color: var(--muted); font-size: 11px; min-width: 70px; font-family: monospace; }
  .activity-item .tool { font-weight: 500; flex: 1; }
  .activity-item .dur { color: var(--muted); font-size: 12px; font-family: monospace; }
  .activity-result { display: none; margin-top: 8px; padding: 8px 12px; background: var(--bg); border-radius: 6px;
    font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-word; color: var(--muted);
    max-height: 200px; overflow-y: auto; line-height: 1.5; }
  .activity-item.expanded .activity-result { display: block; }
  .expand-icon { color: var(--muted); font-size: 10px; min-width: 16px; text-align: center; transition: transform 0.15s; }
  .activity-item.expanded .expand-icon { transform: rotate(90deg); }
  .bar-container { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 4px; }
  .bar { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
  .bar-green { background: var(--green); }
  .bar-red { background: var(--red); }
  .empty { color: var(--muted); text-align: center; padding: 24px; font-style: italic; }
  .refresh-info { font-size: 11px; color: var(--muted); text-align: right; margin-bottom: 8px; }
  @media (max-width: 600px) {
    body { padding: 8px; }
    .grid { grid-template-columns: 1fr; }
    .stat { font-size: 22px; }
  }
</style>
</head>
<body>
<h1><span class="dot" id="statusDot"></span> AHK MCP Monitor</h1>
<div class="refresh-info">Auto-refresh: 3s | <span id="lastUpdate">-</span></div>

<div class="grid">
  <div class="card">
    <h2>Server</h2>
    <div class="stat" id="uptime">-</div>
    <div class="stat-label">Uptime</div>
    <div class="stat-row" style="margin-top:12px">
      <div><div class="stat" style="font-size:18px" id="memHeap">-</div><div class="stat-label">Heap MB</div></div>
      <div><div class="stat" style="font-size:18px" id="memRss">-</div><div class="stat-label">RSS MB</div></div>
      <div><div class="stat" style="font-size:18px" id="traceCount">-</div><div class="stat-label">Traces</div></div>
    </div>
  </div>
  <div class="card">
    <h2>Sessions</h2>
    <div class="stat" id="sessionCount">0</div>
    <div class="stat-label">Active connections</div>
    <div id="sessionList" style="margin-top:12px"></div>
  </div>
  <div class="card">
    <h2>Tool Calls</h2>
    <div class="stat" id="totalCalls">0</div>
    <div class="stat-label">Total calls</div>
    <div class="stat-row" style="margin-top:12px">
      <div><div class="stat" style="font-size:18px;color:var(--green)" id="successRate">-</div><div class="stat-label">Success rate</div></div>
      <div><div class="stat" style="font-size:18px" id="avgDuration">-</div><div class="stat-label">Avg ms</div></div>
      <div><div class="stat" style="font-size:18px" id="uniqueTools">-</div><div class="stat-label">Tools used</div></div>
    </div>
  </div>
</div>

<div class="grid" style="grid-template-columns: 1fr 1fr;">
  <div class="card">
    <h2>Tool Usage</h2>
    <div id="toolTable"></div>
  </div>
  <div class="card">
    <h2>Live Activity</h2>
    <div class="activity-list" id="activityList"></div>
  </div>
</div>

<script>
const API = window.location.origin + '/dashboard/api';
let online = false;

function fmt(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? h+'h '+m+'m' : m > 0 ? m+'m '+sec+'s' : sec+'s';
}
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return Math.floor(ms/1000)+'s ago';
  if (ms < 3600000) return Math.floor(ms/60000)+'m ago';
  return Math.floor(ms/3600000)+'h ago';
}
function timeOnly(iso) {
  return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

async function fetchJSON(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function refresh() {
  try {
    const [stats, sessions, tools, toolsAll, activity] = await Promise.all([
      fetchJSON('/stats'), fetchJSON('/sessions'), fetchJSON('/tools'),
      fetchJSON('/tools/all'), fetchJSON('/activity')
    ]);
    online = true;
    document.getElementById('statusDot').className = 'dot';
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

    // Stats
    document.getElementById('uptime').textContent = fmt(stats.uptime);
    document.getElementById('memHeap').textContent = stats.memory.heapUsedMB;
    document.getElementById('memRss').textContent = stats.memory.rssMB;
    document.getElementById('traceCount').textContent = stats.tracing.totalTraces;

    // Sessions
    document.getElementById('sessionCount').textContent = sessions.count;
    const sl = document.getElementById('sessionList');
    if (sessions.sessions.length === 0) {
      sl.innerHTML = '<div class="empty">No active sessions</div>';
    } else {
      sl.innerHTML = sessions.sessions.map(s =>
        '<div class="stat-row"><span class="badge badge-proto">'+s.protocol+'</span>' +
        '<span style="font-size:12px;color:var(--muted)">'+s.id+' &middot; '+ago(s.lastActivity)+'</span></div>'
      ).join('');
    }

    // Tools summary
    document.getElementById('totalCalls').textContent = tools.totalCalls;
    document.getElementById('successRate').textContent = tools.overallSuccessRate.toFixed(1)+'%';
    document.getElementById('avgDuration').textContent = Math.round(tools.averageDuration);
    document.getElementById('uniqueTools').textContent = tools.uniqueTools;

    // Tool table
    const tt = document.getElementById('toolTable');
    if (toolsAll.tools.length === 0) {
      tt.innerHTML = '<div class="empty">No tool calls yet</div>';
    } else {
      tt.innerHTML = '<table><tr><th>Tool</th><th>Calls</th><th>Rate</th><th>Avg</th></tr>' +
        toolsAll.tools.slice(0, 15).map(t => {
          const rate = parseFloat(t.successRate);
          const rateClass = rate >= 90 ? 'badge-ok' : rate >= 50 ? '' : 'badge-err';
          return '<tr><td style="font-weight:500">'+t.name.replace('AHK_','')+'</td>' +
            '<td>'+t.totalCalls+'</td>' +
            '<td><span class="badge '+rateClass+'">'+t.successRate+'%</span></td>' +
            '<td style="color:var(--muted)">'+t.averageDuration+'ms</td></tr>';
        }).join('') + '</table>';
    }

    // Activity
    const al = document.getElementById('activityList');
    if (activity.activity.length === 0) {
      al.innerHTML = '<div class="empty">No activity yet</div>';
    } else {
      al.innerHTML = activity.activity.slice(0, 30).map((a,i) => {
        const icon = a.success ? '<span class="badge badge-ok">OK</span>' : '<span class="badge badge-err">ERR</span>';
        const hasResult = a.result || a.error;
        const resultText = a.error ? 'Error: '+esc(a.error) : esc(a.result||'No output captured');
        return '<div class="activity-item" onclick="this.classList.toggle(\\'expanded\\')">' +
          '<div class="activity-row">' +
          (hasResult ? '<span class="expand-icon">&#9654;</span>' : '<span class="expand-icon"></span>') +
          '<span class="time">'+timeOnly(a.time)+'</span>' +
          icon +
          '<span class="tool">'+a.tool.replace('AHK_','')+'</span>' +
          '<span class="dur">'+a.duration+'ms</span></div>' +
          (hasResult ? '<div class="activity-result">'+resultText+'</div>' : '') +
          '</div>';
      }).join('');
    }
  } catch(e) {
    online = false;
    document.getElementById('statusDot').className = 'dot offline';
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
