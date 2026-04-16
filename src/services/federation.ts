/**
 * Federation service — syncs positions between multiple E7APRS instances.
 *
 * Each backend broadcasts locally-received positions to configured peer URLs.
 * Incoming federated positions are tagged with origin to prevent infinite loops.
 */
import { config } from '../config';
import { Position } from '../types';
import { addPosition } from './store';
import { broadcastPosition } from '../socket/index';
import { recordPosition } from './source-health';

// Positions we've seen (avoid re-broadcasting federated positions)
const seenIds = new Set<string>();
const SEEN_TTL = 60_000;

function posKey(pos: Position): string {
  return `${pos.radioId}:${pos.timestamp}`;
}

/**
 * Broadcast a locally-originated position to all federation peers.
 */
export function federatePosition(pos: Position): void {
  if (config.federationPeers.length === 0) return;

  const key = posKey(pos);
  if (seenIds.has(key)) return; // already federated
  seenIds.add(key);
  setTimeout(() => seenIds.delete(key), SEEN_TTL);

  for (const peerUrl of config.federationPeers) {
    const url = `${peerUrl}/api/federation/receive`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pos),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // Peer unreachable — expected during network outages
    });
  }
}

/**
 * Handle an incoming position from a federation peer.
 * Returns true if the position was new and stored.
 */
export async function receiveFederatedPosition(pos: Position): Promise<boolean> {
  const key = posKey(pos);
  if (seenIds.has(key)) return false; // already seen
  seenIds.add(key);
  setTimeout(() => seenIds.delete(key), SEEN_TTL);

  const accepted = await addPosition(pos);
  if (accepted) {
    recordPosition(pos.source);
    broadcastPosition(pos);
  }
  return accepted;
}
