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

// ─── APRS-IS passcode algorithm ───────────────────────────────────────────────
function calcPasscode(callsign: string): number {
  const base = callsign.split('-')[0].toUpperCase();
  let hash = 0x73e2;
  let i = 0;
  while (i < base.length) {
    hash ^= base.charCodeAt(i++) << 8;
    if (i < base.length) hash ^= base.charCodeAt(i++);
  }
  return hash & 0x7fff;
}

// ─── Decimal degrees → APRS DDmm.mm format ───────────────────────────────────
function fmtLat(deg: number): string {
  const d = Math.floor(Math.abs(deg));
  const m = (Math.abs(deg) - d) * 60;
  return `${String(d).padStart(2, '0')}${m.toFixed(2).padStart(5, '0')}${deg >= 0 ? 'N' : 'S'}`;
}

function fmtLon(deg: number): string {
  const d = Math.floor(Math.abs(deg));
  const m = (Math.abs(deg) - d) * 60;
  return `${String(d).padStart(3, '0')}${m.toFixed(2).padStart(5, '0')}${deg >= 0 ? 'E' : 'W'}`;
}

// ─── Build APRS position packet ───────────────────────────────────────────────
function buildPacket(
  callsign: string, lat: number, lon: number,
  course: number, speedKnots: number, comment: string
): string {
  const symbol      = '>';   // car/mobile
  const symbolTable = '/';
  const c = String(Math.round(course)).padStart(3, '0');
  const s = String(Math.round(speedKnots)).padStart(3, '0');
  return `${callsign}>APRS,TCPIP*:!${fmtLat(lat)}${symbolTable}${fmtLon(lon)}${symbol}${c}/${s}${comment}`;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}
 
const CALLSIGN = getArg('callsign', 'E70AB');
const BASE_LAT = parseFloat(getArg('lat',   '44.53808102155324'));  // Stara Tržnica 14
const BASE_LON = parseFloat(getArg('lon',   '18.67541460596559'));
const COUNT    = parseInt(getArg('count',   '0'), 10);    // 0 = infinite
const INTERVAL = parseInt(getArg('interval','10000'), 10);
const HOST     = getArg('host', 'rotate.aprs2.net');
const PORT     = parseInt(getArg('port', '14580'), 10);

const PASSCODE = calcPasscode(CALLSIGN);

console.log(`[mock] Callsign : ${CALLSIGN}`);
console.log(`[mock] Passcode : ${PASSCODE}`);
console.log(`[mock] Start    : ${BASE_LAT}, ${BASE_LON}`);
console.log(`[mock] Interval : ${INTERVAL}ms`);
console.log(`[mock] Count    : ${COUNT === 0 ? 'infinite' : COUNT}`);
console.log(`[mock] Server   : ${HOST}:${PORT}`);
console.log('');

// ─── Simulated movement ───────────────────────────────────────────────────────
let lat = BASE_LAT;
let lon = BASE_LON;
let bearing = 45;

function step(): void {
  const rad = (bearing * Math.PI) / 180;
  lat += Math.cos(rad) * 0.00003;
  lon += Math.sin(rad) * 0.00003;
  bearing = (bearing + (Math.random() * 30 - 15)) % 360;
  if (bearing < 0) bearing += 360;
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
    timer = setInterval(() => {
      step();
      const speedKnots = 5;
      const packet = buildPacket(CALLSIGN, lat, lon, bearing, speedKnots, ' Mock/aprs-tracker');
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
