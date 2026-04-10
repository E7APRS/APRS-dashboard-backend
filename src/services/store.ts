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

/**
 * Dedup + priority rules:
 *   - Skip if new timestamp is older than the latest stored position.
 *   - Skip if timestamps are equal and new source is not 'aprsis' (APRS-IS has priority).
 *   - Overwrite (replace history entry + DB row) if timestamps are equal and new source IS 'aprsis'.
 *   - Normal insert when new timestamp is strictly newer.
 *
 * Returns true if the position was accepted and stored, false if it was dropped.
 */
export async function addPosition(pos: Position): Promise<boolean> {
  const existing = deviceCache.get(pos.radioId);
  const existingLatest = existing?.lastPosition;

  let isOverwrite = false;

  if (existingLatest) {
    const existingTime = new Date(existingLatest.timestamp).getTime();
    const newTime      = new Date(pos.timestamp).getTime();

    if (newTime < existingTime) {
      // Older than latest — drop
      return false;
    }

    if (newTime === existingTime) {
      if (pos.source !== 'aprsis') {
        // Same timestamp, lower-priority source — drop
        return false;
      }
      // Same timestamp, aprsis wins — overwrite existing record
      isOverwrite = true;
    }
  }

  // 1. Update in-memory cache
  const history = positionCache.get(pos.radioId) ?? [];

  if (isOverwrite) {
    // Replace the last entry that shares this timestamp instead of appending
    const idx = history.findLastIndex(p => p.timestamp === pos.timestamp);
    if (idx !== -1) {
      history[idx] = pos;
    } else {
      history.push(pos);
    }
  } else {
    history.push(pos);
    if (history.length > HISTORY_LIMIT) history.shift();
  }

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
    return false;
  }

  // When overwriting with aprsis, remove the existing same-timestamp row first
  if (isOverwrite) {
    const { error: delErr } = await sb
      .from('positions')
      .delete()
      .eq('radio_id', pos.radioId)
      .eq('timestamp', pos.timestamp);
    if (delErr) console.error('[store] position dedup-delete error:', delErr.message);
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

  return true;
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

      // Back-fill deviceCache.lastPosition with the most recent position from
      // positionCache, which includes symbol/symbolTable. The devices table
      // doesn't store those fields, so without this the initial snapshot sent
      // to connecting clients has no symbol info — aprsfi markers show as plain
      // circles until the next poll.
      for (const [radioId, history] of positionCache.entries()) {
        const latest = history.at(-1);
        if (!latest) continue;
        const device = deviceCache.get(radioId);
        if (device) device.lastPosition = latest;
      }
    }
  }

  console.log(`[store] Cache warmed — ${deviceCache.size} device(s), ${
    Array.from(positionCache.values()).reduce((s, h) => s + h.length, 0)
  } position(s) loaded from Supabase`);
}
