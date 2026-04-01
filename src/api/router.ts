import { Router, Request, Response } from 'express';
import {
  getAllDevices,
  getDevice,
  getLatestPositions,
  getHistoryFromDb,
  addPosition,
} from '../services/store';
import { config } from '../config';
import { Position } from '../types';
import { broadcastPosition } from '../socket/index';

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
    simulator: {
      enabled:  config.dataSources.includes('simulator'),
      interval: config.simulator.interval,
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
  const limit = Math.min(parseInt(req.query.limit as string ?? '500', 10), 2000);
  const history = await getHistoryFromDb(req.params.radioId, limit);
  res.json(history);
});

// Manual GPS push (for future DMR integration)
router.post('/gps', async (req: Request, res: Response) => {
  const body = req.body as Partial<Position>;

  if (!body.radioId || !body.callsign || body.lat === undefined || body.lon === undefined) {
    res.status(400).json({ error: 'Missing required fields: radioId, callsign, lat, lon' });
    return;
  }

  const position: Position = {
    radioId:   body.radioId,
    callsign:  body.callsign,
    lat:       body.lat,
    lon:       body.lon,
    altitude:  body.altitude,
    speed:     body.speed,
    course:    body.course,
    comment:   body.comment,
    timestamp: body.timestamp ?? new Date().toISOString(),
    source:    'dmr',
  };

  await addPosition(position);
  broadcastPosition(position);

  res.status(201).json(position);
});

export default router;
