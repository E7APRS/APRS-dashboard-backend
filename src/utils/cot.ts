/**
 * Cursor on Target (CoT) XML formatting.
 *
 * Maps E7APRS Position objects to CoT event XML for ATAK integration.
 * Reference: MIL-STD-2525C and CoT schema.
 */
import { Position } from '../types';

// Map APRS source types to CoT type strings
const SOURCE_TO_COT_TYPE: Record<string, string> = {
  aprsfi:     'a-f-G-U-C',  // friendly ground unit civilian
  aprsis:     'a-f-G-U-C',
  dmr:        'a-f-G-U-C',
  relay:      'a-f-G-U-C',
  meshtastic: 'a-f-G-U-C',
  mqtt:       'a-f-G-U-C',
  simulator:  'a-f-G-U-C-F', // friendly ground unit civilian fake
  fixed:      'a-f-G-I',     // friendly ground installation
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert a single Position to a CoT event XML string.
 */
export function positionToCot(pos: Position): string {
  const now = new Date();
  const time = new Date(pos.timestamp).toISOString();
  const stale = new Date(now.getTime() + 5 * 60_000).toISOString(); // 5 min stale
  const type = SOURCE_TO_COT_TYPE[pos.source] ?? 'a-f-G-U-C';
  const uid = `E7APRS-${pos.radioId}`;

  let detail = `<contact callsign="${escapeXml(pos.callsign)}"/>`;
  detail += `<remarks source="E7APRS">${escapeXml(pos.comment ?? `Source: ${pos.source}`)}</remarks>`;

  if (pos.course !== undefined) {
    detail += `<track course="${pos.course}" speed="${pos.speed !== undefined ? (pos.speed / 3.6).toFixed(2) : '0'}"/>`;
  }

  detail += `<__group name="Cyan" role="Team Member"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="${escapeXml(uid)}" type="${type}" how="m-g" time="${time}" start="${time}" stale="${stale}">
  <point lat="${pos.lat}" lon="${pos.lon}" hae="${pos.altitude ?? 0}" ce="35.0" le="999999.0"/>
  <detail>${detail}</detail>
</event>`;
}

/**
 * Convert an array of positions to CoT XML events (concatenated).
 */
export function positionsToCot(positions: Position[]): string {
  return positions.map(positionToCot).join('\n');
}
