/**
 * Shared position ingestion pipeline.
 *
 * Stores the position, records health, broadcasts via Socket.io,
 * checks geofences, forwards to TAK and federation peers, and
 * notifies the relay webhook.
 */
import { Position } from '../types';
import { addPosition } from './store';
import { recordPosition } from './source-health';
import { broadcastPosition } from '../socket/index';
import { checkGeofences } from './geofence';
import { sendToTak } from './tak-bridge';
import { federatePosition } from './federation';
import { config } from '../config';

export async function ingestPosition(pos: Position): Promise<boolean> {
  const accepted = await addPosition(pos);
  if (!accepted) return false;

  recordPosition(pos.source);
  broadcastPosition(pos);
  checkGeofences(pos);
  sendToTak(pos);
  federatePosition(pos);

  if (config.relayWebhookUrl) {
    fetch(config.relayWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pos),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }

  return true;
}
