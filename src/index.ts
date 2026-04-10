import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { config, isEnabled } from './config';
import { Position } from './types';
import apiRouter from './api/router';
import { requireAuth } from './middleware/requireAuth';
import { initSocket, broadcastPosition } from './socket/index';
import { addPosition, warmCache } from './services/store';
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

app.get('/', (_req, res) => {
  res.json({
    name: 'aprs-tracker',
    activeSources: config.dataSources,
    endpoints: [
      'GET  /api/status',
      'GET  /api/devices',
      'GET  /api/devices/:radioId',
      'GET  /api/positions/latest',
      'GET  /api/positions/:radioId/history',
      'POST /api/gps',
    ],
  });
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
