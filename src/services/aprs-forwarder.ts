/**
 * APRS-IS forwarder
 *
 * Uploads a position to APRS-IS using the callsign's own passcode.
 * Each callsign gets a short-lived, dedicated TCP connection — APRS-IS
 * tier-2 servers reject packets where the source callsign doesn't match
 * the logged-in user, so we can't reuse a single shared connection.
 *
 * After upload the packet propagates through APRS-IS and arrives back
 * via our aprsis.ts listener, which is the canonical path into the store.
 */
import net from 'net';
import { Position } from '../types';
import { config } from '../config';

// ─── APRS-IS passcode ─────────────────────────────────────────────────────────

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

// ─── Compressed position packet ───────────────────────────────────────────────

function b91(val: number): string {
  val = Math.round(val);
  const chars: string[] = [];
  for (let i = 0; i < 4; i++) {
    chars.unshift(String.fromCharCode((val % 91) + 33));
    val = Math.floor(val / 91);
  }
  return chars.join('');
}

function buildPacket(pos: Position): string {
  const compLat  = b91(380926 * (90 - pos.lat));
  const compLon  = b91(190463 * (180 + pos.lon));
  const symTable = pos.symbolTable ?? '/';
  const symCode  = pos.symbol ?? '[';          // default: person/handheld

  const course     = pos.course ?? 0;
  const speedKnots = pos.speed !== undefined ? pos.speed / 1.852 : 0;
  const c = String.fromCharCode(Math.round(course / 4) % 91 + 33);
  const s = String.fromCharCode(Math.min(90, Math.round(Math.log(speedKnots + 1) / Math.log(1.08))) + 33);

  const comment = pos.comment ?? '';

  // TCPIP* in path marks this as an internet-injected packet
  return `${pos.callsign}>APRS,TCPIP*:!${symTable}${compLat}${compLon}${symCode}${c}${s}!${comment}`;
}

// ─── Forwarder ────────────────────────────────────────────────────────────────

export function forwardToAprsis(pos: Position): void {
  const { host, port } = config.aprsis;
  const passcode = calcPasscode(pos.callsign);

  const sock = new net.Socket();

  sock.connect(port, host, () => {
    sock.write(`user ${pos.callsign} pass ${passcode} vers aprs-tracker 1.0\r\n`);

    // Small delay — let the server process the login before sending the packet
    setTimeout(() => {
      const packet = buildPacket(pos);
      sock.write(packet + '\r\n');
      console.log(`[forwarder] ${pos.callsign} → APRS-IS (pass=${passcode}): ${packet.slice(0, 100)}`);
      setTimeout(() => sock.destroy(), 500);
    }, 500);
  });

  sock.on('error', err => {
    console.error(`[forwarder] ${pos.callsign} error:`, err.message);
  });
}
