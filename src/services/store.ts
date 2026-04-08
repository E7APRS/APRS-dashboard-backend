/**
 * Position store — dual layer:
 *   - In-memory cache for fast reads (WebSocket broadcast, snapshot)
 *   - Supabase for persistence (history, survive restarts)
 *
 * On startup: warms cache from the latest Supabase records.
 */
import { Position, Device } from '../types';
import { getSupabase } from './supabase';

const HISTORY_LIMIT = 100;
const MAX_DEVICES   = 5000; // guard against unbounded cache growth

// In-memory cache
const positionCache  = new Map<string, Position[]>();
const deviceCache    = new Map<string, Device>();

// ─── Write ────────────────────────────────────────────────────────────────────

export async function addPosition(pos: Position): Promise<void> {
  // 1. Update in-memory cache immediately (fast path for broadcast)
  const history = positionCache.get(pos.radioId) ?? [];
  history.push(pos);
  if (history.length > HISTORY_LIMIT) history.shift();
  positionCache.set(pos.radioId, history);

  // Evict oldest device if cache is full (prevents unbounded growth)
  if (deviceCache.size >= MAX_DEVICES && !deviceCache.has(pos.radioId)) {
    const oldest = deviceCache.keys().next().value;
    if (oldest) { deviceCache.delete(oldest); positionCache.delete(oldest); }
  }

  deviceCache.set(pos.radioId, {
    radioId:      pos.radioId,
    callsign:     pos.callsign,
    lastSeen:     pos.timestamp,
    lastPosition: pos,
  });

  // 2. Persist to Supabase (non-blocking — log errors, don't throw)

  const sb = getSupabase();

  // Device must exist before position (foreign key) — sequential
  const { error: devErr } = await sb.from('devices').upsert({
    radio_id:  pos.radioId,
    callsign:  pos.callsign,
    last_seen: pos.timestamp,
    last_lat:  pos.lat,
    last_lon:  pos.lon,
  }, { onConflict: 'radio_id' });

  if (devErr) {
    console.error('[store] device upsert error:', devErr.message);
    return;
  }

  const { error: posErr } = await sb.from('positions').insert({
    radio_id:     pos.radioId,
    callsign:     pos.callsign,
    lat:          pos.lat,
    lon:          pos.lon,
    altitude:     pos.altitude     ?? null,
    speed:        pos.speed        ?? null,
    course:       pos.course       ?? null,
    comment:      pos.comment      ?? null,
    symbol:       pos.symbol       ?? null,
    symbol_table: pos.symbolTable  ?? null,
    source:       pos.source,
    timestamp:    pos.timestamp,
  });

  if (posErr) console.error('[store] position insert error:', posErr.message);
}

// ─── Read (in-memory) ─────────────────────────────────────────────────────────

export function getAllDevices(): Device[] {
  return Array.from(deviceCache.values());
}

export function getDevice(radioId: string): Device | undefined {
  return deviceCache.get(radioId);
}

export function getHistory(radioId: string): Position[] {
  return positionCache.get(radioId) ?? [];
}

export function getLatestPositions(): Position[] {
  return Array.from(deviceCache.values()).map(d => d.lastPosition);
}

// ─── Read (Supabase — used by API for full history) ───────────────────────────

export async function getHistoryFromDb(radioId: string, limit = 500): Promise<Position[]> {
  const { data, error } = await getSupabase()
    .from('positions')
    .select('*')
    .eq('radio_id', radioId)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[store] getHistoryFromDb error:', error.message);
    return [];
  }

  return (data ?? []).map(row => ({
    radioId:     row.radio_id,
    callsign:    row.callsign,
    lat:         row.lat,
    lon:         row.lon,
    altitude:    row.altitude     ?? undefined,
    speed:       row.speed        ?? undefined,
    course:      row.course       ?? undefined,
    comment:     row.comment      ?? undefined,
    symbol:      row.symbol       ?? undefined,
    symbolTable: row.symbol_table ?? undefined,
    timestamp:   row.timestamp,
    source:      row.source as Position['source'],
  })).reverse();
}

// ─── Cache warm-up on startup ─────────────────────────────────────────────────

export async function warmCache(): Promise<void> {
  const sb = getSupabase();

  const { data: devices, error: devErr } = await sb
    .from('devices')
    .select('*');

  if (devErr) {
    console.warn('[store] warmCache devices error:', devErr.message);
    return;
  }

  for (const row of devices ?? []) {
    const lastPosition: Position = {
      radioId:   row.radio_id,
      callsign:  row.callsign,
      lat:       row.last_lat,
      lon:       row.last_lon,
      timestamp: row.last_seen,
      source:    row.source ?? 'aprsfi',
    };

    deviceCache.set(row.radio_id, {
      radioId:      row.radio_id,
      callsign:     row.callsign,
      lastSeen:     row.last_seen,
      lastPosition,
    });
  }

  // Populate positionCache with recent history from Supabase
  if (deviceCache.size > 0) {
    const { data: positions, error: posErr } = await sb
      .from('positions')
      .select('*')
      .in('radio_id', Array.from(deviceCache.keys()))
      .order('timestamp', { ascending: true })
      .limit(deviceCache.size * HISTORY_LIMIT);

    if (posErr) {
      console.warn('[store] warmCache positions error:', posErr.message);
    } else {
      for (const row of positions ?? []) {
        const history = positionCache.get(row.radio_id) ?? [];
        history.push({
          radioId:     row.radio_id,
          callsign:    row.callsign,
          lat:         row.lat,
          lon:         row.lon,
          altitude:    row.altitude     ?? undefined,
          speed:       row.speed        ?? undefined,
          course:      row.course       ?? undefined,
          comment:     row.comment      ?? undefined,
          symbol:      row.symbol       ?? undefined,
          symbolTable: row.symbol_table ?? undefined,
          timestamp:   row.timestamp,
          source:      (row.source ?? 'aprsfi') as Position['source'],
        });
        if (history.length > HISTORY_LIMIT) history.shift();
        positionCache.set(row.radio_id, history);
      }
    }
  }

  console.log(`[store] Cache warmed — ${deviceCache.size} device(s), ${
    Array.from(positionCache.values()).reduce((s, h) => s + h.length, 0)
  } position(s) loaded from Supabase`);
}
