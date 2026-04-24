import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { DataSource, Position } from './types';
import apiRouter from './api/router';
import authRouter from './api/auth-router';
import { requireAuth } from './middleware/requireAuth';
import { initSocket, broadcast } from './socket/index';
import { getAllDevices, warmCache } from './services/store';
import { initDatabase } from './services/database';
import { setPositionHandler, startSource, getRunning } from './services/source-manager';
import { startJournalReplay } from './services/supabase-journal';
import {
  startHealthMonitor,
  setHealthChangeCallback,
  getAllHealth,
} from './services/source-health';
import { startSync } from './services/sync';
import { startCapPoller } from './services/cap';
import { startTakBridge } from './services/tak-bridge';
import { ingestPosition } from './services/ingest';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '5mb' }));
// Serve avatar images from same base dir as SQLite (persistent volume in production)
app.use('/avatars', express.static(path.join(path.dirname(config.sqlite.path), 'avatars')));
// POST /api/gps, /api/relay, /api/federation/receive use API key auth; all other /api routes require JWT
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && (req.path === '/gps' || req.path === '/relay' || req.path === '/federation/receive')) return next();
  return requireAuth(req, res, next);
});
app.use('/api', apiRouter);
app.use('/api/auth', authRouter);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getLastPacketInfo(): { iso: string | null; ageSeconds: number | null } {
  const latestMs = getAllDevices().reduce<number | null>((max, device) => {
    const ts = Date.parse(device.lastSeen);
    if (Number.isNaN(ts)) return max;
    if (max === null || ts > max) return ts;
    return max;
  }, null);

  if (latestMs === null) return { iso: null, ageSeconds: null };
  return {
    iso: new Date(latestMs).toISOString(),
    ageSeconds: Math.max(0, Math.floor((Date.now() - latestMs) / 1000)),
  };
}

app.get('/', (_req, res) => {
  const lastPacket = getLastPacketInfo();
  const running = getRunning();
  const health = getAllHealth();
  const devices = getAllDevices();
  const payload = {
    status: 'ok',
    service: 'aprs-tracker',
    now: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    lastPacketReceived: lastPacket.iso,
    lastPacketAgeSeconds: lastPacket.ageSeconds,
    runningSources: running,
    configuredSources: config.dataSources,
    sourceHealth: health,
    deviceCount: devices.length,
    apiStatusEndpoint: '/api/status',
  };

  if (_req.accepts('json') && !_req.accepts('html')) {
    res.json(payload);
    return;
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  function statusBadge(status: string): string {
    const colors: Record<string, string> = {
      up:       'background:#c6f6d5;color:#22543d',
      degraded: 'background:#fefcbf;color:#744210',
      down:     'background:#fed7d7;color:#822727',
      disabled: 'background:#e2e8f0;color:#718096',
    };
    const style = colors[status] ?? colors.disabled;
    return `<span class="badge" style="${style}">${escapeHtml(status.toUpperCase())}</span>`;
  }

  function timeAgo(iso: string | null): string {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 1000) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  }

  const ALL_SOURCES = ['aprsfi', 'aprsis', 'meshtastic', 'mqtt', 'dmr', 'fixed', 'relay'] as const;
  const healthBySource = new Map(health.map(h => [h.source, h]));

  const sourceRows = ALL_SOURCES.map(source => {
    const h = healthBySource.get(source);
    const status = h?.status ?? 'disabled';
    return `
        <tr>
          <td><strong>${escapeHtml(source)}</strong></td>
          <td>${statusBadge(status)}</td>
          <td>${h ? timeAgo(h.lastPositionAt) : '—'}</td>
          <td>${h ? h.positionsTotal.toLocaleString() : '0'}</td>
          <td>${h?.lastError ? `<span class="err">${escapeHtml(h.lastError)}</span>` : '—'}</td>
        </tr>`;
  }).join('');

  const deviceRows = devices.slice(0, 20).map(d => {
    const age = Date.now() - new Date(d.lastSeen).getTime();
    const stale = age > 600_000;
    return `
      <tr${stale ? ' class="stale"' : ''}>
        <td><strong>${escapeHtml(d.callsign)}</strong></td>
        <td><code>${escapeHtml(d.radioId)}</code></td>
        <td>${escapeHtml(d.lastPosition?.source ?? '—')}</td>
        <td>${timeAgo(d.lastSeen)}</td>
      </tr>`;
  }).join('');

  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>E7APRS Backend — Health</title>
    <meta http-equiv="refresh" content="15" />
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e2e8f0; padding: 1.5rem; }
      .container { max-width: 900px; margin: 0 auto; }
      .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #2d3748; }
      .header h1 { font-size: 1.4rem; color: #ff6600; font-weight: 700; }
      .header .status-pill { font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 999px; background: #c6f6d5; color: #22543d; font-weight: 600; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
      .stat { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 8px; padding: 1rem; }
      .stat .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #718096; margin-bottom: 0.25rem; }
      .stat .value { font-size: 1.3rem; font-weight: 700; color: #f7fafc; }
      .stat .value.orange { color: #ff6600; }
      .card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
      .card-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #a0aec0; padding: 0.75rem 1rem; border-bottom: 1px solid #2d3748; }
      table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
      th { text-align: left; padding: 0.5rem 1rem; color: #718096; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #2d3748; }
      td { padding: 0.5rem 1rem; border-bottom: 1px solid #2d374833; color: #cbd5e0; }
      tr:last-child td { border-bottom: none; }
      tr.stale td { opacity: 0.5; }
      .badge { display: inline-block; font-size: 0.65rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 4px; letter-spacing: 0.03em; }
      .err { color: #fc8181; font-size: 0.8rem; }
      .muted { color: #4a5568; font-style: italic; text-align: center; padding: 1rem; }
      code { background: #2d3748; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.8rem; color: #e2e8f0; }
      .footer { text-align: center; font-size: 0.7rem; color: #4a5568; margin-top: 1.5rem; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>E7APRS Backend</h1>
        <span class="status-pill">HEALTHY</span>
      </div>

      <div class="grid">
        <div class="stat">
          <div class="label">Uptime</div>
          <div class="value">${formatUptime(payload.uptimeSeconds)}</div>
        </div>
        <div class="stat">
          <div class="label">Devices</div>
          <div class="value orange">${payload.deviceCount}</div>
        </div>
        <div class="stat">
          <div class="label">Active Sources</div>
          <div class="value orange">${running.length}</div>
        </div>
        <div class="stat">
          <div class="label">Last Packet</div>
          <div class="value" style="font-size:1rem">${payload.lastPacketAgeSeconds !== null ? `${payload.lastPacketAgeSeconds}s ago` : 'n/a'}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Source Health</div>
        <table>
          <thead><tr><th>Source</th><th>Status</th><th>Last Position</th><th>Total</th><th>Error</th></tr></thead>
          <tbody>${sourceRows}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Devices (${devices.length}${devices.length > 20 ? ', showing 20' : ''})</div>
        <table>
          <thead><tr><th>Callsign</th><th>Radio ID</th><th>Source</th><th>Last Seen</th></tr></thead>
          <tbody>${deviceRows.length > 0 ? deviceRows : '<tr><td colspan="4" class="muted">No devices tracked yet</td></tr>'}</tbody>
        </table>
      </div>

      <div class="footer">Auto-refreshes every 15s &middot; <code>${escapeHtml(payload.now)}</code></div>
    </div>
  </body>
</html>`);
});

const server = http.createServer(app);
initSocket(server);

async function handlePosition(pos: Position): Promise<void> {
  await ingestPosition(pos);
}

async function boot(): Promise<void> {
  // Initialize local PostgreSQL schema
  await initDatabase();

  await warmCache();
  startJournalReplay();
  startSync();
  startHealthMonitor();
  setHealthChangeCallback((health) => broadcast('sources:health', health));

  // Register the position handler and start all sources
  setPositionHandler(handlePosition);

  // Start all known sources — active ones connect/poll, passive ones (dmr, relay) just accept data
  const ALL_BOOT_SOURCES: DataSource[] = ['aprsis', 'aprsfi', 'meshtastic', /* 'mqtt', */ 'fixed', 'dmr', 'relay'];
  for (const source of ALL_BOOT_SOURCES) {
    startSource(source);
  }

  // Start CAP alert poller (independent of data sources)
  startCapPoller();

  // Start TAK Server bridge if configured
  startTakBridge();

  console.log('[boot] Active sources:', getRunning().join(', ') || 'none');

  if (config.dataSources.length === 0) {
    console.log('[boot] No sources enabled — manual POST /api/gps only');
  }

  server.listen(config.port, () => {
    console.log(`[boot] Backend running on http://localhost:${config.port}`);
  });
}

boot().catch(err => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
