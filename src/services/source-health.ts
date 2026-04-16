/**
 * Source health tracker.
 *
 * Monitors the liveness of each data source by tracking when each last
 * produced a position. Exposes health status for the API and broadcasts
 * changes via Socket.io so the frontend can show real-time source state.
 */
import { DataSource } from '../types';

export type SourceStatus = 'up' | 'degraded' | 'down' | 'disabled';

export interface SourceHealth {
  source: DataSource;
  status: SourceStatus;
  lastPositionAt: string | null;   // ISO timestamp of last accepted position
  lastErrorAt: string | null;      // ISO timestamp of last error
  lastError: string | null;        // error message
  positionsTotal: number;          // lifetime accepted count
  connectionAttempts: number;      // for sources with connections (APRS-IS)
}

// Thresholds (ms) — a source is degraded if no position within this window,
// down if no position within 2x.
const THRESHOLDS: Record<string, { degraded: number; down: number }> = {
  aprsis:    { degraded: 60_000,  down: 180_000  },  // expect data every ~30s
  aprsfi:    { degraded: 60_000,  down: 300_000  },  // polls every 15s
  simulator: { degraded: 15_000,  down: 60_000   },
  dmr:       { degraded: 120_000, down: 600_000  },
  relay:     { degraded: 120_000, down: 600_000  },
  fixed:     { degraded: 120_000, down: 600_000  },
};

const healthMap = new Map<DataSource, SourceHealth>();

// Callback for broadcasting changes
let onHealthChange: ((health: SourceHealth[]) => void) | null = null;

export function setHealthChangeCallback(cb: (health: SourceHealth[]) => void): void {
  onHealthChange = cb;
}

function getOrCreate(source: DataSource): SourceHealth {
  let h = healthMap.get(source);
  if (!h) {
    h = {
      source,
      status: 'disabled',
      lastPositionAt: null,
      lastErrorAt: null,
      lastError: null,
      positionsTotal: 0,
      connectionAttempts: 0,
    };
    healthMap.set(source, h);
  }
  return h;
}

/** Mark a source as enabled (called when it starts). */
export function markSourceEnabled(source: DataSource): void {
  const h = getOrCreate(source);
  if (h.status === 'disabled') h.status = 'down'; // waiting for first data
  notifyChange();
}

/** Mark a source as disabled (called when it stops). */
export function markSourceDisabled(source: DataSource): void {
  const h = getOrCreate(source);
  h.status = 'disabled';
  notifyChange();
}

/** Record a successful position from a source. */
export function recordPosition(source: DataSource): void {
  const h = getOrCreate(source);
  h.lastPositionAt = new Date().toISOString();
  h.positionsTotal++;
  const prev = h.status;
  h.status = 'up';
  if (prev !== 'up') notifyChange();
}

/** Record an error from a source. */
export function recordError(source: DataSource, message: string): void {
  const h = getOrCreate(source);
  h.lastErrorAt = new Date().toISOString();
  h.lastError = message;
}

/** Record a connection attempt (for TCP-based sources). */
export function recordConnectionAttempt(source: DataSource): void {
  const h = getOrCreate(source);
  h.connectionAttempts++;
}

/** Recompute status based on staleness thresholds. */
export function refreshStatuses(): void {
  const now = Date.now();
  for (const h of healthMap.values()) {
    if (h.status === 'disabled') continue;
    if (!h.lastPositionAt) {
      h.status = 'down';
      continue;
    }
    const age = now - new Date(h.lastPositionAt).getTime();
    const t = THRESHOLDS[h.source] ?? { degraded: 120_000, down: 600_000 };
    const prev = h.status;
    if (age > t.down) h.status = 'down';
    else if (age > t.degraded) h.status = 'degraded';
    else h.status = 'up';
    if (prev !== h.status) notifyChange();
  }
}

/** Get all source health records. */
export function getAllHealth(): SourceHealth[] {
  return Array.from(healthMap.values());
}

/** Get health for a specific source. */
export function getHealth(source: DataSource): SourceHealth | undefined {
  return healthMap.get(source);
}

function notifyChange(): void {
  onHealthChange?.(getAllHealth());
}

// Periodic status refresh
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthMonitor(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(refreshStatuses, 15_000);
}

export function stopHealthMonitor(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
