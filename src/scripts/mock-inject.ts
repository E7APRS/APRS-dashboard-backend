/**
 * Mock APRS-IS injector
 *
 * Sends fake GPS positions to APRS-IS for a given callsign.
 * The packets flow through the real APRS-IS network and arrive
 * back through your own aprsis.ts listener — full pipeline test.
 *
 * Usage:
 *   npx tsx src/scripts/mock-inject.ts
 *   npx tsx src/scripts/mock-inject.ts --callsign E70AB --lat 43.8563 --lon 18.4131 --count 10
 */
import net from 'net';
import fs from 'fs';
import path from 'path';

// ─── APRS-IS passcode algorithm ───────────────────────────────────────────────
function calcPasscode(callsign: string): number {
  const base = callsign.split('-')[0].split('/')[0].toUpperCase();
  let hash = 0x73e2;
  let i = 0;
  while (i < base.length) {
    hash ^= base.charCodeAt(i++) << 8;
    if (i < base.length) hash ^= base.charCodeAt(i++);
  }
  return hash & 0x7fff;
}

// ─── APRS compressed position packet ─────────────────────────────────────────
// Compressed format gives ~1m resolution vs 18.5m of uncompressed DDmm.mm.
// Spec: APRS 1.01 ch.9 — !/ + 4-char lat + 4-char lon + symbol + cs + T
function buildPacket(
  callsign: string, lat: number, lon: number,
  course: number, speedKnots: number, symCode: string, comment: string
): string {
  const b91 = (val: number): string => {
    val = Math.round(val);
    const chars: string[] = [];
    for (let i = 0; i < 4; i++) {
      chars.unshift(String.fromCharCode((val % 91) + 33));
      val = Math.floor(val / 91);
    }
    return chars.join('');
  };

  const compLat = b91(380926 * (90 - lat));
  const compLon = b91(190463 * (180 + lon));
  const symTable = '/';
  const c = String.fromCharCode(Math.round(course / 4) % 91 + 33);
  const s = String.fromCharCode(Math.min(90, Math.round(Math.log(speedKnots + 1) / Math.log(1.08))) + 33);
  const T = '!';

  return `${callsign}>APRS,TCPIP*:!${symTable}${compLat}${compLon}${symCode}${c}${s}${T}${comment}`;
}

// ─── Fixed stations ───────────────────────────────────────────────────────────
const FIXED_STATIONS = [
  { callsign: 'E70AB',  lat: 44.534722, lon: 18.662583, symbol: '-', comment: ' E70AB shack' },
  { callsign: 'E74BMN', lat: 44.533694, lon: 18.655361, symbol: 'y', comment: ' Radio klub ``Kreka``' }
];

const FIXED_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STATE_FILE = path.join(__dirname, '.mock-inject-state.json');

interface State {
  lastSent:     number;
  lat:          number;
  lon:          number;
  bearing:      number;
  bearingDrift: number;
}

function loadState(): State {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<State>;
    return {
      lastSent:     data.lastSent     ?? 0,
      lat:          data.lat          ?? BASE_LAT,
      lon:          data.lon          ?? BASE_LON,
      bearing:      data.bearing      ?? 45,
      bearingDrift: data.bearingDrift ?? 0,
    };
  } catch {
    return { lastSent: 0, lat: BASE_LAT, lon: BASE_LON, bearing: 45, bearingDrift: 0 };
  }
}

function saveState(): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSent, lat, lon, bearing, bearingDrift }));
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}
 
const CALLSIGN = getArg('callsign', 'E70AB-7'); // -7 = APRS standard SSID for mobile
const BASE_LAT = parseFloat(getArg('lat',   '44.53808102155324'));  // Stara Tržnica 14
const BASE_LON = parseFloat(getArg('lon',   '18.67541460596559'));
const COUNT    = parseInt(getArg('count',   '0'), 10);    // 0 = infinite
const INTERVAL = parseInt(getArg('interval','10000'), 10);
const HOST     = getArg('host', 'rotate.aprs2.net');
const PORT     = parseInt(getArg('port', '14580'), 10);

const _passArg    = getArg('passcode', '');
const PASSCODE    = _passArg !== '' ? parseInt(_passArg, 10) : calcPasscode(CALLSIGN);
const SKIP_TIMEOUT = process.argv.includes('--skip-timeout');

console.log(`[mock] Callsign : ${CALLSIGN}`);
console.log(`[mock] Passcode : ${PASSCODE}`);
console.log(`[mock] Start    : ${BASE_LAT}, ${BASE_LON}`);
console.log(`[mock] Interval : ${INTERVAL}ms`);
console.log(`[mock] Count    : ${COUNT === 0 ? 'infinite' : COUNT}`);
console.log(`[mock] Server   : ${HOST}:${PORT}`);
console.log('');

// ─── Simulated movement ───────────────────────────────────────────────────────
const WALK_SPEED_MS    = 2500 / 3600; // 2.5 km/h in m/s
const DEG_PER_METER_LAT = 1 / 111_000;
const MAX_RADIUS_M     = 100;         // roaming radius from BASE_LAT/BASE_LON

function distFromBase(latP: number, lonP: number): number {
  const dLat = (latP - BASE_LAT) * 111_000;
  const dLon = (lonP - BASE_LON) * 111_000 * Math.cos(BASE_LAT * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

const _state = loadState();
let lat          = _state.lat;
let lon          = _state.lon;
let bearing      = _state.bearing;
let bearingDrift = _state.bearingDrift;
let lastSent     = _state.lastSent;

// If saved position is outside radius (e.g. from a previous unconstrained run), reset to center
if (distFromBase(lat, lon) > MAX_RADIUS_M) {
  lat = BASE_LAT;
  lon = BASE_LON;
  console.log(`[mock] Position was outside ${MAX_RADIUS_M}m radius — reset to center`);
}

console.log(`[mock] Resuming  : ${lat.toFixed(5)}, ${lon.toFixed(5)} bearing ${Math.round(bearing)}°`);

function step(): void {
  const distanceM = WALK_SPEED_MS * (INTERVAL / 1000);

  const rad = (bearing * Math.PI) / 180;
  const degPerMeterLon = 1 / (111_000 * Math.cos(lat * Math.PI / 180));

  lat += distanceM * Math.cos(rad) * DEG_PER_METER_LAT;
  lon += distanceM * Math.sin(rad) * degPerMeterLon;

  // Smooth bearing drift
  bearingDrift = bearingDrift * 0.92 + (Math.random() - 0.5) * 1.0;

  // Elastic boundary: steer back toward center when beyond 70% of radius.
  // Strength ramps from 0→1 between 70m and 100m, overriding free drift near the edge.
  const dist = distFromBase(lat, lon);
  if (dist > MAX_RADIUS_M * 0.7) {
    const dLat = (BASE_LAT - lat) * 111_000;
    const dLon = (BASE_LON - lon) * 111_000 * Math.cos(lat * Math.PI / 180);
    const toCenter = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    const diff     = ((toCenter - bearing + 540) % 360) - 180; // signed angle
    const strength = Math.min(1, (dist - MAX_RADIUS_M * 0.7) / (MAX_RADIUS_M * 0.3));
    bearing      = (bearing + diff * strength * 0.3 + 360) % 360;
    bearingDrift *= (1 - strength * 0.6); // dampen drift near edge
  }

  bearingDrift = Math.max(-3, Math.min(3, bearingDrift));
  bearing = (bearing + bearingDrift + 360) % 360;
  saveState();
}

// ─── Send loop ────────────────────────────────────────────────────────────────
const socket = new net.Socket();
let sent = 0;
let timer: ReturnType<typeof setInterval> | null = null;

socket.connect(PORT, HOST, () => {
  const login = `user ${CALLSIGN} pass ${PASSCODE} vers mock-inject 1.0\r\n`;
  socket.write(login);
  console.log(`[mock] Connected — logged in as ${CALLSIGN}`);

  // Small delay to let server process login before first packet
  setTimeout(() => {
    // Each fixed station opens its own short-lived connection and logs in with its own
    // callsign — this guarantees APRS-IS tier-2 servers accept and forward the packet.
    function sendOneFixed(st: typeof FIXED_STATIONS[0]): void {
      const sock = new net.Socket();
      const pass = calcPasscode(st.callsign);
      sock.connect(PORT, HOST, () => {
        sock.write(`user ${st.callsign} pass ${pass} vers mock-inject 1.0\r\n`);
        setTimeout(() => {
          const p = buildPacket(st.callsign, st.lat, st.lon, 0, 0, st.symbol, st.comment);
          sock.write(p + '\r\n');
          console.log(`[mock] fixed: ${st.callsign} ${st.lat.toFixed(5)}, ${st.lon.toFixed(5)}`);
          setTimeout(() => sock.destroy(), 500);
        }, 500);
      });
      sock.on('error', err => console.error(`[mock] fixed error (${st.callsign}):`, err.message));
    }

    function sendFixed(): void {
      for (const st of FIXED_STATIONS) sendOneFixed(st);
      lastSent = Date.now();
      saveState();
    }

    const elapsed   = Date.now() - lastSent;
    const remaining = FIXED_INTERVAL_MS - elapsed;

    if (SKIP_TIMEOUT || remaining <= 0) {
      if (SKIP_TIMEOUT) console.log('[mock] --skip-timeout: sending fixed stations immediately');
      sendFixed();
      setInterval(sendFixed, FIXED_INTERVAL_MS);
    } else {
      console.log(`[mock] fixed stations skipped — next send in ${Math.round(remaining / 60000)} min`);
      setTimeout(() => {
        sendFixed();
        setInterval(sendFixed, FIXED_INTERVAL_MS);
      }, remaining);
    }

    timer = setInterval(() => {
      step();
      const speedKnots = WALK_SPEED_MS * 1.94384; // 2.5 km/h → knots
      const packet = buildPacket(CALLSIGN, lat, lon, bearing, speedKnots, '[', ' APRS tracker handheld test');
      socket.write(packet + '\r\n');
      sent++;
      console.log(`[mock] #${sent} sent: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);

      if (COUNT > 0 && sent >= COUNT) {
        console.log('[mock] Done.');
        clearInterval(timer!);
        socket.destroy();
        process.exit(0);
      }
    }, INTERVAL);
  }, 1000);
});

socket.on('data', (data) => {
  const msg = data.toString().trim();
  // Only log non-keepalive lines
  if (!msg.startsWith('#')) console.log(`[mock] server: ${msg}`);
});

socket.on('error', (err) => {
  console.error('[mock] Error:', err.message);
  process.exit(1);
});

socket.on('close', () => {
  console.log('[mock] Connection closed');
  if (timer) clearInterval(timer);
});

process.on('SIGINT', () => {
  console.log('\n[mock] Stopped.');
  if (timer) clearInterval(timer);
  socket.destroy();
  process.exit(0);
});
