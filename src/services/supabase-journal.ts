/**
 * Supabase failed-write journal.
 *
 * When a Supabase backup write fails, the operation is appended to a local
 * NDJSON journal file. A background loop periodically replays pending entries,
 * removing them on success.
 *
 * This prevents silent data loss in the backup tier during network blips,
 * rate limits, or transient Supabase outages.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getSupabase } from './supabase';

// Journal lives next to the SQLite database file
const JOURNAL_PATH = path.join(path.dirname(config.sqlite.path), 'supabase-journal.ndjson');
const REPLAY_INTERVAL_MS = 60_000; // replay every 60s
const BATCH_SIZE = 50;             // max entries per replay cycle

interface JournalEntry {
  ts: string;          // ISO timestamp of the original write attempt
  table: string;       // 'devices' | 'positions'
  op: 'upsert' | 'insert' | 'delete_insert';
  payload: Record<string, unknown>;
  deleteMatch?: Record<string, unknown>; // for delete_insert: fields to match on delete
}

let replayTimer: ReturnType<typeof setInterval> | null = null;

/** Append a failed write to the journal. */
export function appendToJournal(entry: JournalEntry): void {
  try {
    const dir = path.dirname(JOURNAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[supabase-journal] Failed to append:', (err as Error).message);
  }
}

/** Read all pending entries from the journal. */
function readJournal(): JournalEntry[] {
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return [];
    const raw = fs.readFileSync(JOURNAL_PATH, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => JSON.parse(line) as JournalEntry);
  } catch (err) {
    console.error('[supabase-journal] Failed to read:', (err as Error).message);
    return [];
  }
}

/** Overwrite journal with remaining entries (atomic via rename). */
function writeJournal(entries: JournalEntry[]): void {
  const tmp = JOURNAL_PATH + '.tmp';
  try {
    if (entries.length === 0) {
      if (fs.existsSync(JOURNAL_PATH)) fs.unlinkSync(JOURNAL_PATH);
      return;
    }
    fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, JOURNAL_PATH);
  } catch (err) {
    console.error('[supabase-journal] Failed to write:', (err as Error).message);
  }
}

/** Replay one entry. Returns true if successful (should be removed). */
async function replayEntry(entry: JournalEntry): Promise<boolean> {
  const sb = getSupabase();

  try {
    if (entry.op === 'upsert') {
      const { error } = await sb.from(entry.table).upsert(entry.payload, {
        onConflict: entry.table === 'devices' ? 'radio_id' : undefined,
      });
      if (error) {
        console.warn(`[supabase-journal] Replay upsert failed (${entry.table}):`, error.message);
        return false;
      }
    } else if (entry.op === 'insert') {
      const { error } = await sb.from(entry.table).insert(entry.payload);
      if (error) {
        // Duplicate insert — treat as success (data already there)
        if (error.code === '23505') return true;
        console.warn(`[supabase-journal] Replay insert failed (${entry.table}):`, error.message);
        return false;
      }
    } else if (entry.op === 'delete_insert' && entry.deleteMatch) {
      let query = sb.from(entry.table).delete();
      for (const [k, v] of Object.entries(entry.deleteMatch)) {
        query = query.eq(k, v as string);
      }
      await query;
      const { error } = await sb.from(entry.table).insert(entry.payload);
      if (error && error.code !== '23505') {
        console.warn(`[supabase-journal] Replay delete_insert failed (${entry.table}):`, error.message);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn('[supabase-journal] Replay error:', (err as Error).message);
    return false;
  }
}

/** Process pending journal entries. */
async function replayCycle(): Promise<void> {
  const entries = readJournal();
  if (entries.length === 0) return;

  const batch = entries.slice(0, BATCH_SIZE);
  const remaining = entries.slice(BATCH_SIZE);
  const failed: JournalEntry[] = [];

  for (const entry of batch) {
    const ok = await replayEntry(entry);
    if (!ok) failed.push(entry);
  }

  writeJournal([...failed, ...remaining]);

  const replayed = batch.length - failed.length;
  if (replayed > 0 || failed.length > 0) {
    console.log(`[supabase-journal] Replayed ${replayed}, failed ${failed.length}, remaining ${remaining.length}`);
  }
}

/** Start the background replay loop. */
export function startJournalReplay(): void {
  if (replayTimer) return;
  replayTimer = setInterval(() => {
    replayCycle().catch(err => {
      console.error('[supabase-journal] Replay cycle error:', (err as Error).message);
    });
  }, REPLAY_INTERVAL_MS);

  // Run once immediately on start
  replayCycle().catch(() => {});

  console.log('[supabase-journal] Replay loop started');
}

/** Stop the background replay loop. */
export function stopJournalReplay(): void {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
}

/** Get journal stats for monitoring. */
export function getJournalStats(): { pending: number; path: string } {
  const entries = readJournal();
  return { pending: entries.length, path: JOURNAL_PATH };
}
