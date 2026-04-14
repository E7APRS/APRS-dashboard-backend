import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { config, isEnabled } from './config';
import { Position } from './types';
import apiRouter from './api/router';
import { requireAuth } from './middleware/requireAuth';
import { initSocket, broadcastPosition } from './socket/index';
import { addPosition, getAllDevices, warmCache } from './services/store';
import { startAprsfiPoller } from './services/aprsfi';
import { startAprsis } from './services/aprsis';
import { startFixedStations } from './services/fixed-stations';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json());
// POST /api/gps uses its own API key auth (for DSD+ forwarder); all other /api routes require JWT
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/gps') return next();
  return requireAuth(req, res, next);
});
app.use('/api', apiRouter);

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
  const payload = {
    status: 'ok',
    service: 'aprs-tracker',
    now: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    lastPacketReceived: lastPacket.iso,
    lastPacketAgeSeconds: lastPacket.ageSeconds,
    activeSources: config.dataSources,
    apiStatusEndpoint: '/api/status',
  };

  if (_req.accepts('json') && !_req.accepts('html')) {
    res.json(payload);
    return;
  }

  const sources = payload.activeSources.length > 0
    ? payload.activeSources.map(source => `<li>${escapeHtml(source)}</li>`).join('')
    : '<li>none</li>';

  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>APRS Backend Health</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; background: #f7fafc; color: #1a202c; }
      .card { max-width: 720px; background: #fff; padding: 1.5rem; border-radius: 10px; box-shadow: 0 1px 6px rgba(0,0,0,.08); }
      .ok { color: #2f855a; font-weight: 700; }
      code { background: #edf2f7; padding: 0.15rem 0.35rem; border-radius: 4px; }
      ul { margin-top: 0.35rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>APRS Backend</h1>
      <p>Status: <span class="ok">${escapeHtml(payload.status.toUpperCase())}</span></p>
      <p>Service: <code>${escapeHtml(payload.service)}</code></p>
      <p>Server time: <code>${escapeHtml(payload.now)}</code></p>
      <p>Uptime: <code>${payload.uptimeSeconds}s</code></p>
      <p>Last packet received: <code>${payload.lastPacketReceived ? escapeHtml(payload.lastPacketReceived) : 'none yet'}</code></p>
      <p>Last packet age: <code>${payload.lastPacketAgeSeconds !== null ? `${payload.lastPacketAgeSeconds}s` : 'n/a'}</code></p>
      <p>Active sources:</p>
      <ul>${sources}</ul>
      <p>API status endpoint: <code>${escapeHtml(payload.apiStatusEndpoint)}</code></p>
    </div>
  </body>
</html>`);
});

const server = http.createServer(app);
initSocket(server);

async function handlePosition(pos: Position): Promise<void> {
  const accepted = await addPosition(pos);
  if (accepted) broadcastPosition(pos);
}

async function boot(): Promise<void> {
  await warmCache();

  console.log('[boot] Active sources:', config.dataSources.join(', '));

  // startFixedStations(handlePosition);
  if (isEnabled('aprsfi')) startAprsfiPoller(handlePosition);
  if (isEnabled('aprsis')) startAprsis(handlePosition);

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
