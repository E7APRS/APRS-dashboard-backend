import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import {
  getAllDevices,
  getDevice,
  getLatestPositions,
  getHistoryFromDb,
  getHistoryRange,
} from '../services/store';
import { config } from '../config';
import { DataSource, Position } from '../types';
import { forwardToAprsis } from '../services/aprs-forwarder';
import { getAllHealth } from '../services/source-health';
import { ingestPosition } from '../services/ingest';
import { getJournalStats } from '../services/supabase-journal';
import { startSource, stopSource, getRunning, isRunning } from '../services/source-manager';
import { getGeofencesByUser, getGeofenceWithOwnerCheck, createGeofence, updateGeofence, deleteGeofence } from '../services/geofence';
import { getActiveCapAlerts } from '../services/cap';
import { positionsToCot } from '../utils/cot';
import { receiveFederatedPosition } from '../services/federation';

// Middleware: require X-Api-Key header matching GPS_API_KEY env var.
// In production (NODE_ENV=production), GPS_API_KEY is mandatory.
// In development, requests pass through unauthenticated if the key is unset.
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.gpsApiKey) {
    if (process.env.NODE_ENV === 'production') {
      res.status(503).json({ error: 'GPS_API_KEY not configured — server misconfigured' });
      return;
    }
    next();
    return;
  }
  const key = req.headers['x-api-key'];
  if (key !== config.gpsApiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** Validate a position payload. Returns an error string or null if valid. */
function validatePosition(body: Record<string, unknown>): string | null {
  if (!body.radioId || typeof body.radioId !== 'string') return 'Missing or invalid radioId';
  if (!body.callsign || typeof body.callsign !== 'string') return 'Missing or invalid callsign';
  if (typeof body.lat !== 'number' || !Number.isFinite(body.lat)) return 'lat must be a finite number';
  if (typeof body.lon !== 'number' || !Number.isFinite(body.lon)) return 'lon must be a finite number';
  if (body.lat < -90 || body.lat > 90) return 'lat must be between -90 and 90';
  if (body.lon < -180 || body.lon > 180) return 'lon must be between -180 and 180';
  if (body.altitude !== undefined && (typeof body.altitude !== 'number' || !Number.isFinite(body.altitude))) return 'altitude must be a finite number';
  if (body.speed !== undefined && (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < 0)) return 'speed must be a non-negative finite number';
  if (body.course !== undefined && (typeof body.course !== 'number' || !Number.isFinite(body.course))) return 'course must be a finite number';
  if (body.radioId.length > 20) return 'radioId exceeds maximum length';
  if (body.callsign.length > 20) return 'callsign exceeds maximum length';
  if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 256)) return 'comment must be a string of max 256 chars';
  if (body.symbol !== undefined && (typeof body.symbol !== 'string' || body.symbol.length > 2)) return 'symbol must be a 1-2 char string';
  if (body.symbolTable !== undefined && (typeof body.symbolTable !== 'string' || body.symbolTable.length > 2)) return 'symbolTable must be a 1-2 char string';
  if (body.timestamp !== undefined && typeof body.timestamp === 'string' && isNaN(Date.parse(body.timestamp))) return 'timestamp must be a valid ISO 8601 string';
  return null;
}

// Rate limiter for position ingestion endpoints (POST /gps, /relay, /federation/receive).
// 100 requests per minute per IP — enough for normal operation, blocks flooding.
const ingestLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

// General rate limiter for authenticated read endpoints
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

// Stricter limiter for admin-level source management
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

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
const TOGGLEABLE_SOURCES: DataSource[] = ['aprsfi', 'aprsis', 'meshtastic', 'mqtt', 'dmr', 'fixed', 'relay'];

router.get('/sources', (_req: Request, res: Response) => {
  res.json({
    running: getRunning(),
    available: TOGGLEABLE_SOURCES,
    health: getAllHealth(),
  });
});

router.post('/sources/:source/start', adminLimiter, (req: Request, res: Response) => {
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

router.post('/sources/:source/stop', adminLimiter, (req: Request, res: Response) => {
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
router.get('/positions/history', apiLimiter, async (req: Request, res: Response) => {
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
// Positions are stored directly in the database and broadcast via Socket.io.
router.post('/gps', ingestLimiter, requireApiKey, async (req: Request, res: Response) => {
  if (!isRunning('dmr')) {
    res.status(503).json({ error: 'DMR source is disabled' });
    return;
  }

  const body = req.body as Record<string, unknown>;

  const error = validatePosition(body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const position: Position = {
    radioId:     body.radioId as string,
    callsign:    body.callsign as string,
    lat:         body.lat as number,
    lon:         body.lon as number,
    altitude:    body.altitude as number | undefined,
    speed:       body.speed as number | undefined,
    course:      body.course as number | undefined,
    comment:     config.dmrComment || (body.comment as string | undefined),
    symbol:      body.symbol as string | undefined,
    symbolTable: body.symbolTable as string | undefined,
    timestamp:   (body.timestamp as string) ?? new Date().toISOString(),
    source:      'dmr',
  };

  await ingestPosition(position);
  res.json({ status: 'ok', callsign: position.callsign });
});

// Forward a device's latest position to APRS-IS on demand.
router.post('/positions/:radioId/forward', adminLimiter, (req: Request, res: Response) => {
  const device = getDevice(req.params.radioId);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  forwardToAprsis(device.lastPosition);
  res.json({ status: 'forwarded', callsign: device.lastPosition.callsign });
});

// Relay ingest — accepts batched positions from lora-relay receiver.
// Writes directly to store + broadcasts via Socket.io (no APRS-IS forward).
router.post('/relay', ingestLimiter, requireApiKey, async (req: Request, res: Response) => {
  const positions = Array.isArray(req.body) ? req.body.slice(0, 200) : [req.body];
  let accepted = 0;
  let rejected = 0;

  for (const body of positions) {
    if (validatePosition(body)) {
      rejected++;
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
      source:      'relay' as const,
    };

    const stored = await ingestPosition(pos);
    if (stored) accepted++;
  }

  res.json({ status: 'ok', accepted, rejected, total: positions.length });
});

// ─── Federation ──────────────────────────────────────────────────────────────

router.post('/federation/receive', ingestLimiter, requireApiKey, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const error = validatePosition(body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const pos: Position = {
    radioId:     body.radioId as string,
    callsign:    body.callsign as string,
    lat:         body.lat as number,
    lon:         body.lon as number,
    altitude:    body.altitude as number | undefined,
    speed:       body.speed as number | undefined,
    course:      body.course as number | undefined,
    comment:     body.comment as string | undefined,
    symbol:      body.symbol as string | undefined,
    symbolTable: body.symbolTable as string | undefined,
    timestamp:   (body.timestamp as string) ?? new Date().toISOString(),
    source:      'relay' as const,
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

router.get('/geofences', (req: Request, res: Response) => {
  res.json(getGeofencesByUser(req.authUserId!));
});

router.get('/geofences/:id', (req: Request, res: Response) => {
  const fence = getGeofenceWithOwnerCheck(req.params.id, req.authUserId!);
  if (!fence) { res.status(404).json({ error: 'Geofence not found' }); return; }
  res.json(fence);
});

router.post('/geofences', (req: Request, res: Response) => {
  const { name, description, geometry, color, watchedCallsigns } = req.body;
  if (!name || !geometry) {
    res.status(400).json({ error: 'Missing required fields: name, geometry' });
    return;
  }
  // Validate GeoJSON Polygon structure
  if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
    res.status(400).json({ error: 'geometry must be a GeoJSON Polygon with coordinates array' });
    return;
  }
  const coords = geometry.coordinates;
  if (!Array.isArray(coords[0]) || coords[0].length < 4) {
    res.status(400).json({ error: 'Polygon must have at least 4 coordinate pairs (closed ring)' });
    return;
  }
  if (coords[0].length > 1000) {
    res.status(400).json({ error: 'Polygon ring exceeds maximum of 1000 points' });
    return;
  }
  const fence = createGeofence({
    name, description, geometry, color,
    createdBy: req.authUserId!,
    watchedCallsigns: watchedCallsigns ?? [],
  });
  res.status(201).json(fence);
});

router.put('/geofences/:id', (req: Request, res: Response) => {
  if (!getGeofenceWithOwnerCheck(req.params.id, req.authUserId!)) {
    res.status(404).json({ error: 'Geofence not found' }); return;
  }
  // Validate geometry if provided in the update
  if (req.body.geometry) {
    const geometry = req.body.geometry;
    if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
      res.status(400).json({ error: 'geometry must be a GeoJSON Polygon with coordinates array' });
      return;
    }
    if (!Array.isArray(geometry.coordinates[0]) || geometry.coordinates[0].length < 4) {
      res.status(400).json({ error: 'Polygon must have at least 4 coordinate pairs (closed ring)' });
      return;
    }
    if (geometry.coordinates[0].length > 1000) {
      res.status(400).json({ error: 'Polygon ring exceeds maximum of 1000 points' });
      return;
    }
  }
  const fence = updateGeofence(req.params.id, req.body);
  res.json(fence);
});

router.delete('/geofences/:id', (req: Request, res: Response) => {
  if (!getGeofenceWithOwnerCheck(req.params.id, req.authUserId!)) {
    res.status(404).json({ error: 'Geofence not found' }); return;
  }
  deleteGeofence(req.params.id);
  res.json({ status: 'deleted' });
});

export default router;
