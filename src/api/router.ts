import { Router, Request, Response, NextFunction } from 'express';
import {
  addPosition,
  getAllDevices,
  getDevice,
  getLatestPositions,
  getHistoryFromDb,
  getHistoryRange,
} from '../services/store';
import { config } from '../config';
import { DataSource, Position } from '../types';
import { forwardToAprsis } from '../services/aprs-forwarder';
import { broadcastPosition } from '../socket/index';
import { getAllHealth } from '../services/source-health';
import { getJournalStats } from '../services/supabase-journal';
import { startSource, stopSource, getRunning, isRunning } from '../services/source-manager';
import { getAllGeofences, getGeofence, createGeofence, updateGeofence, deleteGeofence } from '../services/geofence';
import { getActiveCapAlerts } from '../services/cap';
import { positionsToCot } from '../utils/cot';
import { receiveFederatedPosition } from '../services/federation';

// Middleware: require X-Api-Key header matching GPS_API_KEY env var.
// Skipped if GPS_API_KEY is not configured (development convenience).
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.gpsApiKey) { next(); return; }
  const key = req.headers['x-api-key'];
  if (key !== config.gpsApiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

const router = Router();

// Status + feature flag info
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    activeSources: config.dataSources,
    aprsfi: {
      enabled:      config.dataSources.includes('aprsfi'),
      callsigns:    config.aprsfi.callsigns,
      pollInterval: config.aprsfi.pollInterval,
    },
    aprsis: {
      enabled: config.dataSources.includes('aprsis'),
      filter:  config.aprsis.filter,
    },
  });
});

// Source health status
router.get('/sources/health', (_req: Request, res: Response) => {
  res.json({
    sources: getAllHealth(),
    journal: getJournalStats(),
  });
});

// Runtime source management
const TOGGLEABLE_SOURCES: DataSource[] = ['aprsfi', 'aprsis', 'simulator', 'meshtastic', 'mqtt'];

router.get('/sources', (_req: Request, res: Response) => {
  res.json({
    running: getRunning(),
    available: TOGGLEABLE_SOURCES,
    health: getAllHealth(),
  });
});

router.post('/sources/:source/start', (req: Request, res: Response) => {
  const source = req.params.source as DataSource;
  if (!TOGGLEABLE_SOURCES.includes(source)) {
    res.status(400).json({ error: `Unknown or non-toggleable source: ${source}` });
    return;
  }
  if (isRunning(source)) {
    res.json({ status: 'already_running', source });
    return;
  }
  const started = startSource(source);
  res.json({ status: started ? 'started' : 'failed', source });
});

router.post('/sources/:source/stop', (req: Request, res: Response) => {
  const source = req.params.source as DataSource;
  if (!TOGGLEABLE_SOURCES.includes(source)) {
    res.status(400).json({ error: `Unknown or non-toggleable source: ${source}` });
    return;
  }
  if (!isRunning(source)) {
    res.json({ status: 'not_running', source });
    return;
  }
  const stopped = stopSource(source);
  res.json({ status: stopped ? 'stopped' : 'failed', source });
});

// List all known devices
router.get('/devices', (_req: Request, res: Response) => {
  res.json(getAllDevices());
});

// Get single device
router.get('/devices/:radioId', (req: Request, res: Response) => {
  const device = getDevice(req.params.radioId);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json(device);
});

// Latest position of all devices (in-memory, fast)
router.get('/positions/latest', (_req: Request, res: Response) => {
  res.json(getLatestPositions());
});

// Historical positions for all devices within a time window
// MUST be before :radioId route — otherwise Express matches 'history' as a radioId
router.get('/positions/history', async (req: Request, res: Response) => {
  const start = req.query.start as string | undefined;
  const end   = req.query.end as string | undefined;

  if (!start || !end) {
    res.status(400).json({ error: 'Missing required query params: start, end (ISO 8601)' });
    return;
  }

  const history = await getHistoryRange(start, end);
  res.json(history);
});

// Full position history from database
router.get('/positions/:radioId/history', async (req: Request, res: Response) => {
  const parsed = parseInt(req.query.limit as string ?? '500', 10);
  const limit  = Math.min(Math.max(1, isNaN(parsed) ? 500 : parsed), 2000);
  const history = await getHistoryFromDb(req.params.radioId, limit);
  res.json(history);
});

// Manual GPS push (DMR bridge / DSD+) — requires X-Api-Key if GPS_API_KEY is set.
// Position is NOT stored directly: it is forwarded to APRS-IS and will arrive
// back through the aprsis.ts listener, which is the canonical store path.
router.post('/gps', requireApiKey, (req: Request, res: Response) => {
  const body = req.body as Partial<Position>;

  if (!body.radioId || !body.callsign || body.lat === undefined || body.lon === undefined) {
    res.status(400).json({ error: 'Missing required fields: radioId, callsign, lat, lon' });
    return;
  }

  const position: Position = {
    radioId:     body.radioId,
    callsign:    body.callsign,
    lat:         body.lat,
    lon:         body.lon,
    altitude:    body.altitude,
    speed:       body.speed,
    course:      body.course,
    comment:     config.dmrComment || body.comment,
    symbol:      body.symbol,
    symbolTable: body.symbolTable,
    timestamp:   body.timestamp ?? new Date().toISOString(),
    source:      'dmr',
  };

  forwardToAprsis(position);

  // 202 Accepted — position is in-flight to APRS-IS, not yet in the store
  res.status(202).json({ status: 'forwarded', callsign: position.callsign });
});

// Relay ingest — accepts batched positions from lora-relay receiver.
// Writes directly to store + broadcasts via Socket.io (no APRS-IS forward).
router.post('/relay', requireApiKey, async (req: Request, res: Response) => {
  const positions = Array.isArray(req.body) ? req.body : [req.body];
  let accepted = 0;

  for (const body of positions) {
    if (!body.radioId || !body.callsign || body.lat === undefined || body.lon === undefined) {
      continue;
    }

    const pos: Position = {
      radioId:     body.radioId,
      callsign:    body.callsign,
      lat:         body.lat,
      lon:         body.lon,
      altitude:    body.altitude,
      speed:       body.speed,
      course:      body.course,
      comment:     body.comment,
      symbol:      body.symbol,
      symbolTable: body.symbolTable,
      timestamp:   body.timestamp ?? new Date().toISOString(),
      source:      body.source ?? 'relay',
    };

    const stored = await addPosition(pos);
    if (stored) {
      broadcastPosition(pos);
      accepted++;
    }
  }

  res.json({ status: 'ok', accepted, total: positions.length });
});

// ─── Federation ──────────────────────────────────────────────────────────────

router.post('/federation/receive', requireApiKey, async (req: Request, res: Response) => {
  const body = req.body as Partial<Position>;
  if (!body.radioId || !body.callsign || body.lat === undefined || body.lon === undefined) {
    res.status(400).json({ error: 'Invalid position data' });
    return;
  }

  const pos: Position = {
    radioId:     body.radioId,
    callsign:    body.callsign,
    lat:         body.lat,
    lon:         body.lon,
    altitude:    body.altitude,
    speed:       body.speed,
    course:      body.course,
    comment:     body.comment,
    symbol:      body.symbol,
    symbolTable: body.symbolTable,
    timestamp:   body.timestamp ?? new Date().toISOString(),
    source:      body.source ?? 'relay',
  };

  const accepted = await receiveFederatedPosition(pos);
  res.json({ status: accepted ? 'accepted' : 'duplicate' });
});

// ─── TAK/CoT Export ──────────────────────────────────────────────────────────

router.get('/export/cot', (_req: Request, res: Response) => {
  const positions = getLatestPositions();
  const xml = positionsToCot(positions);
  res.type('application/xml').send(xml);
});

// ─── CAP Alerts ──────────────────────────────────────────────────────────────

router.get('/cap/alerts', (_req: Request, res: Response) => {
  res.json(getActiveCapAlerts());
});

// ─── Geofence CRUD ───────────────────────────────────────────────────────────

router.get('/geofences', (_req: Request, res: Response) => {
  res.json(getAllGeofences());
});

router.get('/geofences/:id', (req: Request, res: Response) => {
  const fence = getGeofence(req.params.id);
  if (!fence) { res.status(404).json({ error: 'Geofence not found' }); return; }
  res.json(fence);
});

router.post('/geofences', (req: Request, res: Response) => {
  const { name, description, geometry, color } = req.body;
  if (!name || !geometry) {
    res.status(400).json({ error: 'Missing required fields: name, geometry' });
    return;
  }
  const fence = createGeofence({ name, description, geometry, color });
  res.status(201).json(fence);
});

router.put('/geofences/:id', (req: Request, res: Response) => {
  const fence = updateGeofence(req.params.id, req.body);
  if (!fence) { res.status(404).json({ error: 'Geofence not found' }); return; }
  res.json(fence);
});

router.delete('/geofences/:id', (req: Request, res: Response) => {
  const deleted = deleteGeofence(req.params.id);
  if (!deleted) { res.status(404).json({ error: 'Geofence not found' }); return; }
  res.json({ status: 'deleted' });
});

export default router;
