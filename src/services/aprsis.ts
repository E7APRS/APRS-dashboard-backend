/**
 * APRS-IS direct TCP connection.
 *
 * APRS-IS is a real-time internet gateway for APRS packets.
 * It supports server-side filters so you can receive ALL packets
 * matching a prefix (e.g. "p/E7" = every callsign starting with E7)
 * without knowing exact callsigns in advance.
 *
 * Filter reference: http://www.aprs-is.net/javAPRSFilter.aspx
 */
import net from 'net';
import { Position } from '../types';
import { config } from '../config';

const DEBUG = process.env.APRSIS_DEBUG === '1';

// ─── Coordinate parser ────────────────────────────────────────────────────────

function parseDegMin(value: string, direction: string): number {
  const dotIdx = value.indexOf('.');
  const degrees = parseInt(value.slice(0, dotIdx - 2), 10);
  const minutes = parseFloat(value.slice(dotIdx - 2));
  let decimal = degrees + minutes / 60;
  if (direction === 'S' || direction === 'W') decimal = -decimal;
  return parseFloat(decimal.toFixed(6));
}

// ─── Packet parser ────────────────────────────────────────────────────────────

interface ParsedPacket {
  callsign: string;
  lat: number;
  lon: number;
  course?: number;
  speed?: number;
  altitude?: number;
  comment?: string;
  symbol?: string;
  symbolTable?: string;
}

// Uncompressed position body: DDMM.mmN/DDDMM.mmESymbol[CCC/SSS][comment]
// course/speed are optional — many trackers omit them
const POSITION_RE =
  /^(\d{4}\.\d{2})([NS])([\/\\])(\d{5}\.\d{2})([EW])(.)(?:(\d{3})\/(\d{3}))?/;

// Compressed position body: symTable(1) + lat(4 base-91) + lon(4 base-91) + sym(1) + c(1) + s(1) + T(1)
const COMPRESSED_RE = /^([\/\\])([\x21-\x7b]{4})([\x21-\x7b]{4})([\x21-\x7b])([\x20-\x7b])([\x20-\x7b])([\x21-\x7b])/;

function b91decode(s: string): number {
  let v = 0;
  for (let i = 0; i < s.length; i++) v = v * 91 + (s.charCodeAt(i) - 33);
  return v;
}

function parseAprsPacket(raw: string): ParsedPacket | null {
  // Format: CALLSIGN>PATH:payload
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) return null;

  const header  = raw.slice(0, colonIdx);
  const payload = raw.slice(colonIdx + 1);
  const callsign = header.split('>')[0]?.trim();
  if (!callsign) return null;

  // Only position report types
  const type = payload[0];
  if (!['!', '=', '@', '/', '`', "'"].includes(type)) return null;

  // Strip leading timestamp (DDHHmmz / DDHHmmh / HHmmss format)
  const body = payload.slice(1).replace(/^\d{6}[hz]/i, '');

  // ── Try uncompressed first ────────────────────────────────────────────────
  const match = body.match(POSITION_RE);
  if (match) {
    const [, latVal, latDir, symTable, lonVal, lonDir, symCode, courseStr, speedStr] = match;
    const lat = parseDegMin(latVal, latDir);
    const lon = parseDegMin(lonVal, lonDir);
    const course     = courseStr ? parseInt(courseStr, 10) : undefined;
    const speedKnots = speedStr  ? parseInt(speedStr, 10)  : undefined;
    const speed      = speedKnots !== undefined ? Math.round(speedKnots * 1.852) : undefined;
    const fixedLen   = match[7] ? 27 : 20;
    const rawComment = body.slice(fixedLen).trim() || undefined;
    const altMatch   = rawComment?.match(/\/A=(\d+)/);
    const altitude   = altMatch ? Math.round(parseInt(altMatch[1], 10) * 0.3048) : undefined;
    const comment    = rawComment?.replace(/\/A=\d+/, '').trim() || undefined;
    return { callsign, lat, lon, course, speed, altitude, comment, symbol: symCode, symbolTable: symTable };
  }

  // ── Try compressed ────────────────────────────────────────────────────────
  const cm = body.match(COMPRESSED_RE);
  if (cm) {
    const [, symTable, compLat, compLon, symCode, c, s] = cm;
    const lat = 90  - b91decode(compLat) / 380926;
    const lon = -180 + b91decode(compLon) / 190463;
    const cVal = c.charCodeAt(0) - 33;
    const sVal = s.charCodeAt(0) - 33;
    const course = cVal > 0 ? cVal * 4 : undefined;
    const speedKnots = Math.pow(1.08, sVal) - 1;
    const speed = speedKnots > 0.1 ? Math.round(speedKnots * 1.852) : undefined;
    const comment = body.slice(cm[0].length).trim() || undefined;
    return { callsign, lat, lon, course, speed, comment, symbol: symCode, symbolTable: symTable };
  }

  if (DEBUG) console.log(`[aprsis] no match: ${raw.slice(0, 80)}`);
  return null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function startAprsis(onPosition: (pos: Position) => void): () => void {
  const { host, port, callsign, filter } = config.aprsis;
  let socket: net.Socket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let rxCount = 0;
  let parsedCount = 0;

  function connect(): void {
    if (stopped) return;

    console.log(`[aprsis] Connecting to ${host}:${port} — filter: "${filter}"`);
    socket = new net.Socket();
    let buffer = '';

    socket.connect(port, host, () => {
      console.log('[aprsis] Connected');
      socket!.write(`user ${callsign} pass -1 vers aprs-tracker 1.0 filter ${filter}\r\n`);
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#')) {
          console.log(`[aprsis] ${trimmed}`);   // server status messages
          continue;
        }

        rxCount++;
        if (DEBUG) console.log(`[aprsis] RAW: ${trimmed}`);

        const parsed = parseAprsPacket(trimmed);
        if (!parsed) continue;

        parsedCount++;
        console.log(`[aprsis] ${parsed.callsign} → ${parsed.lat}, ${parsed.lon}`);

        onPosition({
          radioId:     parsed.callsign,
          callsign:    parsed.callsign,
          lat:         parsed.lat,
          lon:         parsed.lon,
          altitude:    parsed.altitude,
          speed:       parsed.speed,
          course:      parsed.course,
          comment:     parsed.comment,
          symbol:      parsed.symbol,
          symbolTable: parsed.symbolTable,
          timestamp:   new Date().toISOString(),
          source:      'aprsis',
        });
      }
    });

    socket.on('error', err => {
      console.error('[aprsis] Socket error:', err.message);
    });

    socket.on('close', () => {
      if (stopped) return;
      console.log(`[aprsis] Disconnected (rx=${rxCount} parsed=${parsedCount}) — reconnecting in 10s`);
      reconnectTimer = setTimeout(connect, 10_000);
    });
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.destroy();
    console.log('[aprsis] Stopped');
  };
}
