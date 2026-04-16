/**
 * Position store — three layers:
 *   - In-memory cache for fast reads (WebSocket broadcast, snapshot)
 *   - Local SQLite for primary persistence
 *   - Supabase for backup persistence (non-blocking, best-effort)
 *
 * On startup: warms cache from local SQLite first, falls back to Supabase.
 */
import { Position, Device } from '../types';
import { queryAll, run } from './database';
import { getSupabase } from './supabase';
import { appendToJournal } from './supabase-journal';

const HISTORY_LIMIT = 100;
const MAX_DEVICES   = 5000; // guard against unbounded cache growth

// Content-based dedup: positions within this lat/lon tolerance and time
// window from the same callsign are considered duplicates across sources.
const DEDUP_COORD_EPSILON = 0.0001;  // ~11 meters at the equator
const DEDUP_TIME_WINDOW   = 30_000;  // 30 seconds

// In-memory cache
const positionCache  = new Map<string, Position[]>();
const deviceCache    = new Map<string, Device>();

// ─── Supabase backup (fire-and-forget) ───────────────────────────────────────

async function backupDeviceToSupabase(pos: Position): Promise<void> {
  const payload = {
    radio_id:  pos.radioId,
    callsign:  pos.callsign,
    last_seen: pos.timestamp,
    last_lat:  pos.lat,
    last_lon:  pos.lon,
  };
  try {
    const { error } = await getSupabase().from('devices').upsert(payload, { onConflict: 'radio_id' });
    if (error) {
      console.warn('[store] Supabase device backup failed, journaling:', error.message);
      appendToJournal({ ts: new Date().toISOString(), table: 'devices', op: 'upsert', payload });
    }
  } catch (err) {
    console.warn('[store] Supabase device backup error, journaling:', (err as Error).message);
    appendToJournal({ ts: new Date().toISOString(), table: 'devices', op: 'upsert', payload });
  }
}

async function backupPositionToSupabase(pos: Position, isOverwrite: boolean): Promise<void> {
  const payload = {
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
  };
  try {
    const sb = getSupabase();
    if (isOverwrite) {
      await sb.from('positions').delete()
        .eq('radio_id', pos.radioId)
        .eq('timestamp', pos.timestamp);
    }
    const { error } = await sb.from('positions').insert(payload);
    if (error) {
      console.warn('[store] Supabase position backup failed, journaling:', error.message);
      const op = isOverwrite ? 'delete_insert' as const : 'insert' as const;
      const deleteMatch = isOverwrite ? { radio_id: pos.radioId, timestamp: pos.timestamp } : undefined;
      appendToJournal({ ts: new Date().toISOString(), table: 'positions', op, payload, deleteMatch });
    }
  } catch (err) {
    console.warn('[store] Supabase position backup error, journaling:', (err as Error).message);
    const op = isOverwrite ? 'delete_insert' as const : 'insert' as const;
    const deleteMatch = isOverwrite ? { radio_id: pos.radioId, timestamp: pos.timestamp } : undefined;
    appendToJournal({ ts: new Date().toISOString(), table: 'positions', op, payload, deleteMatch });
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Dedup + priority rules:
 *   - Skip if new timestamp is older than the latest stored position.
 *   - Skip if timestamps are equal and new source is not 'aprsis' (APRS-IS has priority).
 *   - Overwrite (replace history entry + DB row) if timestamps are equal and new source IS 'aprsis'.
 *   - Content-based dedup: skip if another source already delivered a position
 *     with the same lat/lon (within ~11m) in the last 30s.
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
      return false;
    }

    if (newTime === existingTime) {
      if (pos.source !== 'aprsis') {
        return false;
      }
      isOverwrite = true;
    }

    // Content-based dedup: if a different source delivered a nearly identical
    // position (same lat/lon within epsilon) within the time window, skip it.
    // APRS-IS always wins over other sources for the same physical packet.
    if (!isOverwrite && pos.source !== 'aprsis' && existingLatest.source !== pos.source) {
      const timeDiff = Math.abs(newTime - existingTime);
      const latDiff  = Math.abs(pos.lat - existingLatest.lat);
      const lonDiff  = Math.abs(pos.lon - existingLatest.lon);
      if (timeDiff <= DEDUP_TIME_WINDOW && latDiff <= DEDUP_COORD_EPSILON && lonDiff <= DEDUP_COORD_EPSILON) {
        return false;
      }
    }
  }

  // 1. Update in-memory cache
  const history = positionCache.get(pos.radioId) ?? [];

  if (isOverwrite) {
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

  // 2. Persist to local SQLite (primary)
  try {
    run(
      `INSERT INTO devices (radio_id, callsign, last_seen, last_lat, last_lon, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (radio_id) DO UPDATE SET
         callsign  = excluded.callsign,
         last_seen = excluded.last_seen,
         last_lat  = excluded.last_lat,
         last_lon  = excluded.last_lon,
         source    = excluded.source`,
      [pos.radioId, pos.callsign, pos.timestamp, pos.lat, pos.lon, pos.source],
    );

    if (isOverwrite) {
      run(
        `DELETE FROM positions WHERE radio_id = ? AND timestamp = ?`,
        [pos.radioId, pos.timestamp],
      );
    }

    run(
      `INSERT INTO positions (radio_id, callsign, lat, lon, altitude, speed, course, comment, symbol, symbol_table, source, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pos.radioId, pos.callsign, pos.lat, pos.lon,
        pos.altitude ?? null, pos.speed ?? null, pos.course ?? null,
        pos.comment ?? null, pos.symbol ?? null, pos.symbolTable ?? null,
        pos.source, pos.timestamp,
      ],
    );
  } catch (err) {
    console.error('[store] SQLite write error:', (err as Error).message);
    return false;
  }

  // 3. Mirror to Supabase (backup — non-blocking, best-effort)
  backupDeviceToSupabase(pos).catch(() => {});
  backupPositionToSupabase(pos, isOverwrite).catch(() => {});

  return true;
}

// ─── Staleness ───────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 10 * 60_000; // 10 minutes without update = stale

function withStaleness(device: Device): Device {
  const age = Date.now() - new Date(device.lastSeen).getTime();
  return { ...device, stale: age > STALE_THRESHOLD_MS, lastSeenAgeMs: Math.max(0, age) };
}

// ─── Read (in-memory) ─────────────────────────────────────────────────────────

export function getAllDevices(): Device[] {
  return Array.from(deviceCache.values()).map(withStaleness);
}

export function getDevice(radioId: string): Device | undefined {
  const d = deviceCache.get(radioId);
  return d ? withStaleness(d) : undefined;
}

export function getHistory(radioId: string): Position[] {
  return positionCache.get(radioId) ?? [];
}

export function getLatestPositions(): Position[] {
  return Array.from(deviceCache.values()).map(d => d.lastPosition);
}

// ─── Read (database — used by API for full history) ──────────────────────────

function rowToPosition(row: Record<string, unknown>): Position {
  return {
    radioId:     row.radio_id as string,
    callsign:    row.callsign as string,
    lat:         row.lat as number,
    lon:         row.lon as number,
    altitude:    (row.altitude as number | null) ?? undefined,
    speed:       (row.speed as number | null) ?? undefined,
    course:      (row.course as number | null) ?? undefined,
    comment:     (row.comment as string | null) ?? undefined,
    symbol:      (row.symbol as string | null) ?? undefined,
    symbolTable: (row.symbol_table as string | null) ?? undefined,
    timestamp:   row.timestamp as string,
    source:      row.source as Position['source'],
  };
}

export async function getHistoryFromDb(radioId: string, limit = 500): Promise<Position[]> {
  // Try local SQLite first
  try {
    const rows = queryAll<Record<string, unknown>>(
      `SELECT * FROM positions WHERE radio_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [radioId, limit],
    );
    return rows.map(rowToPosition).reverse();
  } catch (err) {
    console.warn('[store] SQLite history read failed, falling back to Supabase:', (err as Error).message);
  }

  // Fallback to Supabase
  const { data, error } = await getSupabase()
    .from('positions')
    .select('*')
    .eq('radio_id', radioId)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[store] Supabase getHistoryFromDb error:', error.message);
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

// ─── Cache warm-up on startup (union merge) ─────────────────────────────────

/** Merge a position into the history cache, maintaining sort order and limit. */
function mergeIntoHistory(radioId: string, pos: Position): void {
  const history = positionCache.get(radioId) ?? [];

  // Skip if already have this exact position (same timestamp + source)
  if (history.some(p => p.timestamp === pos.timestamp && p.source === pos.source)) return;

  // Insert in sorted order by timestamp
  let inserted = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (new Date(history[i].timestamp).getTime() <= new Date(pos.timestamp).getTime()) {
      history.splice(i + 1, 0, pos);
      inserted = true;
      break;
    }
  }
  if (!inserted) history.unshift(pos);

  // Trim to limit
  while (history.length > HISTORY_LIMIT) history.shift();

  positionCache.set(radioId, history);
}

/** Merge a device into the device cache, keeping the one with newer lastSeen. */
function mergeDevice(row: { radio_id: string; callsign: string; last_seen: string; last_lat: number; last_lon: number; source?: string }): void {
  const existing = deviceCache.get(row.radio_id);
  const newTime = new Date(row.last_seen).getTime();

  if (existing && new Date(existing.lastSeen).getTime() >= newTime) return;

  const lastPosition: Position = {
    radioId:   row.radio_id,
    callsign:  row.callsign,
    lat:       row.last_lat,
    lon:       row.last_lon,
    timestamp: row.last_seen,
    source:    (row.source ?? 'aprsfi') as Position['source'],
  };

  deviceCache.set(row.radio_id, {
    radioId:      row.radio_id,
    callsign:     row.callsign,
    lastSeen:     row.last_seen,
    lastPosition,
  });
}

export async function warmCache(): Promise<void> {
  let sqliteDevices = 0;
  let sqlitePositions = 0;

  // ── Phase 1: Load from SQLite ──────────────────────────────────────────────
  try {
    const devices = queryAll<Record<string, unknown>>('SELECT * FROM devices');
    for (const row of devices) {
      mergeDevice({
        radio_id:  row.radio_id as string,
        callsign:  row.callsign as string,
        last_seen: row.last_seen as string,
        last_lat:  row.last_lat as number,
        last_lon:  row.last_lon as number,
        source:    row.source as string | undefined,
      });
    }
    sqliteDevices = devices.length;

    if (deviceCache.size > 0) {
      const radioIds = Array.from(deviceCache.keys());
      const placeholders = radioIds.map(() => '?').join(',');
      const positions = queryAll<Record<string, unknown>>(
        `SELECT * FROM positions WHERE radio_id IN (${placeholders}) ORDER BY timestamp ASC LIMIT ?`,
        [...radioIds, deviceCache.size * HISTORY_LIMIT],
      );

      for (const row of positions) {
        mergeIntoHistory(row.radio_id as string, rowToPosition(row));
      }
      sqlitePositions = positions.length;
    }

    console.log(`[store] SQLite: ${sqliteDevices} device(s), ${sqlitePositions} position(s)`);
  } catch (err) {
    console.warn('[store] SQLite warm-up failed:', (err as Error).message);
  }

  // ── Phase 2: Merge from Supabase (additive — fills gaps) ──────────────────
  let supabaseDevices = 0;
  let supabasePositions = 0;

  try {
    const sb = getSupabase();
    const { data: devices, error: devErr } = await sb.from('devices').select('*');

    if (devErr) {
      console.warn('[store] warmCache Supabase devices error:', devErr.message);
    } else {
      for (const row of devices ?? []) {
        mergeDevice(row);
      }
      supabaseDevices = (devices ?? []).length;
    }

    if (deviceCache.size > 0) {
      const { data: positions, error: posErr } = await sb
        .from('positions')
        .select('*')
        .in('radio_id', Array.from(deviceCache.keys()))
        .order('timestamp', { ascending: true })
        .limit(deviceCache.size * HISTORY_LIMIT);

      if (posErr) {
        console.warn('[store] warmCache Supabase positions error:', posErr.message);
      } else {
        for (const row of positions ?? []) {
          mergeIntoHistory(row.radio_id, {
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
        }
        supabasePositions = (positions ?? []).length;
      }
    }

    console.log(`[store] Supabase: ${supabaseDevices} device(s), ${supabasePositions} position(s)`);
  } catch (err) {
    console.warn('[store] Supabase warm-up failed:', (err as Error).message);
  }

  // ── Phase 3: Back-fill deviceCache.lastPosition from merged history ────────
  for (const [radioId, history] of positionCache.entries()) {
    const latest = history.at(-1);
    if (!latest) continue;
    const device = deviceCache.get(radioId);
    if (device) device.lastPosition = latest;
  }

  const totalPositions = Array.from(positionCache.values()).reduce((s, h) => s + h.length, 0);
  console.log(`[store] Cache warmed (merged) — ${deviceCache.size} device(s), ${totalPositions} position(s)`);
}
