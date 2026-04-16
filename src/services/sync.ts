/**
 * Periodic Supabase → SQLite catch-up sync.
 *
 * Discovers positions that exist in Supabase but are missing from the local
 * SQLite, and backfills them. This handles the case where a remote relay
 * receiver writes to the same Supabase from a different backend instance,
 * or where local SQLite was rebuilt/lost.
 *
 * Runs every N minutes, pulling only positions newer than the last sync
 * watermark to keep queries efficient.
 */
import { queryAll, queryOne, run } from './database';
import { getSupabase } from './supabase';
import { Position } from '../types';

const SYNC_INTERVAL_MS = 5 * 60_000; // every 5 minutes
const BATCH_LIMIT = 500;

let syncTimer: ReturnType<typeof setInterval> | null = null;

/** Find the newest position timestamp in local SQLite. */
function getLocalWatermark(): string {
  const row = queryOne<{ max_ts: string | null }>(
    `SELECT MAX(timestamp) as max_ts FROM positions`,
  );
  // Default to 24 hours ago if no data
  return row?.max_ts ?? new Date(Date.now() - 86_400_000).toISOString();
}

/** Pull positions from Supabase that are missing locally and insert them. */
async function syncCycle(): Promise<void> {
  const watermark = getLocalWatermark();

  const { data: remotePositions, error } = await getSupabase()
    .from('positions')
    .select('*')
    .gt('timestamp', watermark)
    .order('timestamp', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.warn('[sync] Supabase fetch error:', error.message);
    return;
  }

  if (!remotePositions || remotePositions.length === 0) return;

  let inserted = 0;

  for (const row of remotePositions) {
    // Check if this exact position already exists locally
    const exists = queryOne(
      `SELECT 1 FROM positions WHERE radio_id = ? AND timestamp = ? AND source = ?`,
      [row.radio_id, row.timestamp, row.source],
    );

    if (exists) continue;

    // Ensure device exists
    try {
      run(
        `INSERT INTO devices (radio_id, callsign, last_seen, last_lat, last_lon, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (radio_id) DO UPDATE SET
           last_seen = CASE WHEN excluded.last_seen > devices.last_seen THEN excluded.last_seen ELSE devices.last_seen END,
           last_lat  = CASE WHEN excluded.last_seen > devices.last_seen THEN excluded.last_lat ELSE devices.last_lat END,
           last_lon  = CASE WHEN excluded.last_seen > devices.last_seen THEN excluded.last_lon ELSE devices.last_lon END,
           source    = CASE WHEN excluded.last_seen > devices.last_seen THEN excluded.source ELSE devices.source END`,
        [row.radio_id, row.callsign, row.timestamp, row.lat, row.lon, row.source],
      );

      run(
        `INSERT INTO positions (radio_id, callsign, lat, lon, altitude, speed, course, comment, symbol, symbol_table, source, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.radio_id, row.callsign, row.lat, row.lon,
          row.altitude ?? null, row.speed ?? null, row.course ?? null,
          row.comment ?? null, row.symbol ?? null, row.symbol_table ?? null,
          row.source, row.timestamp,
        ],
      );

      inserted++;
    } catch (err) {
      console.warn('[sync] Insert error:', (err as Error).message);
    }
  }

  if (inserted > 0) {
    console.log(`[sync] Backfilled ${inserted} position(s) from Supabase`);
  }
}

export function startSync(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    syncCycle().catch(err => {
      console.error('[sync] Cycle error:', (err as Error).message);
    });
  }, SYNC_INTERVAL_MS);

  // First sync after a short delay (let boot complete)
  setTimeout(() => {
    syncCycle().catch(err => {
      console.error('[sync] Initial cycle error:', (err as Error).message);
    });
  }, 30_000);

  console.log('[sync] Supabase → SQLite catch-up sync started');
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
