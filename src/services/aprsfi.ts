/**
 * APRS.fi API client
 *
 * Terms of service compliance:
 * - User-Agent identifies this app + version + link (required by ToS)
 * - Exponential backoff on consecutive failures (required by ToS)
 * - Minimum poll interval 15s by default to avoid unnecessary load
 * - Data is only fetched when the service is running (no preloading/archiving)
 * - Frontend must display attribution: "Data from aprs.fi" with a link
 */
import { Position } from '../types';
import { config } from '../config';

const APRSFI_BASE_URL = 'https://api.aprs.fi/api/get';

// Required by APRS.fi ToS: identify app name, version, and homepage
const USER_AGENT = 'aprs-tracker/1.0 (+https://github.com/your-org/aprs-tracker)';

const BACKOFF_BASE_MS  = 10_000;   // 10s initial backoff
const BACKOFF_MAX_MS   = 300_000;  // 5 min max backoff
const BACKOFF_FACTOR   = 2;

interface AprsfiEntry {
  name: string;
  showname?: string;
  type: string;
  time: string;
  lasttime: string;
  lat: string;
  lng: string;
  altitude?: string;
  speed?: string;
  course?: string;
  symbol?: string;
  srccall?: string;
  comment?: string;
}

interface AprsfiResponse {
  command: string;
  result: string;
  what: string;
  found: number;
  entries?: AprsfiEntry[];
}

async function fetchAprsfi(callsigns: string[]): Promise<Position[]> {
  if (!config.aprsfi.apiKey) {
    console.warn('[aprsfi] No API key configured — skipping fetch');
    return [];
  }

  const names = callsigns.join(',');
  const url = `${APRSFI_BASE_URL}?name=${encodeURIComponent(names)}&what=loc&apikey=${config.aprsfi.apiKey}&format=json`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10_000), // 10s request timeout (ToS recommendation)
  });

  if (!res.ok) {
    throw new Error(`APRS.fi HTTP error: ${res.status}`);
  }

  const data = await res.json() as AprsfiResponse;

  if (data.result !== 'ok') {
    throw new Error(`APRS.fi API error: ${JSON.stringify(data)}`);
  }

  return (data.entries ?? []).map(entry => {
    console.log('[aprsfi] symbol raw:', entry.name, JSON.stringify(entry.symbol));
    return ({
    radioId:   entry.name,
    callsign:  entry.name,
    lat:       parseFloat(entry.lat),
    lon:       parseFloat(entry.lng),
    altitude:  entry.altitude ? parseFloat(entry.altitude) : undefined,
    speed:     entry.speed    ? parseFloat(entry.speed)    : undefined,
    course:    entry.course   ? parseFloat(entry.course)   : undefined,
    comment:     entry.comment,
    symbol:      entry.symbol?.length === 2 ? entry.symbol[1] : entry.symbol,
    symbolTable: entry.symbol?.length === 2 ? entry.symbol[0] : '/',
    timestamp:   new Date(parseInt(entry.lasttime, 10) * 1000).toISOString(),
    source:    'aprsfi' as const,
  });
  });
}

export function startAprsfiPoller(onPosition: (pos: Position) => void): () => void {
  const { callsigns, pollInterval } = config.aprsfi;

  if (callsigns.length === 0) {
    console.warn('[aprsfi] No callsigns configured in APRSFI_CALLSIGNS');
  }

  console.log('[aprsfi] Started polling:', callsigns, '— interval:', pollInterval, 'ms');

  let stopped       = false;
  let failStreak    = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function backoffDelay(): number {
    const delay = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, failStreak - 1);
    return Math.min(delay, BACKOFF_MAX_MS);
  }

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      const positions = await fetchAprsfi(callsigns);
      failStreak = 0; // reset on success
      for (const pos of positions) {
        onPosition(pos);
      }
      console.log(`[aprsfi] Fetched ${positions.length} positions`);
    } catch (err) {
      failStreak++;
      const delay = backoffDelay();
      console.error(`[aprsfi] Poll error (streak=${failStreak}, next in ${delay / 1000}s):`, err);
      // Override next schedule with backoff delay
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, delay);
      return;
    }

    timer = setTimeout(poll, pollInterval);
  }

  // Initial fetch immediately
  poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log('[aprsfi] Stopped');
  };
}
