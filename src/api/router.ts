import { Router, Request, Response, NextFunction } from 'express';
import {
  addPosition,
  getAllDevices,
  getDevice,
  getLatestPositions,
  getHistoryFromDb,
} from '../services/store';
import { config } from '../config';
import { Position } from '../types';
import { forwardToAprsis } from '../services/aprs-forwarder';
import { broadcastPosition } from '../socket/index';

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

// Full position history from Supabase
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

// Relay ingest — accepts batched positions from aprs-relay receiver.
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

export default router;
