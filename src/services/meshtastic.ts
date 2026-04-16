/**
 * Meshtastic MQTT bridge — ingests position data from Meshtastic mesh nodes
 * via the public or private MQTT broker.
 *
 * Meshtastic nodes publish JSON-encoded messages to topics like:
 *   msh/EU_868/2/json/{channel}/{gateway_id}
 *
 * Position messages have type "position" with lat/lon in 1e-7 scaled integers.
 */
import mqtt from 'mqtt';
import { config } from '../config';
import { Position } from '../types';

interface MeshtasticPositionPayload {
  type: 'position';
  from: number;
  to: number;
  sender: string;
  payload: {
    latitude_i?: number;
    longitude_i?: number;
    altitude?: number;
    ground_speed?: number;
    ground_track?: number;
    time?: number;
  };
}

export function startMeshtastic(onPosition: (pos: Position) => void): () => void {
  const { brokerUrl, topic, username, password } = config.meshtastic;

  console.log(`[meshtastic] Connecting to ${brokerUrl}, topic: ${topic}`);

  const client = mqtt.connect(brokerUrl, {
    username: username || undefined,
    password: password || undefined,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log('[meshtastic] Connected to MQTT broker');
    client.subscribe(topic, (err) => {
      if (err) console.error('[meshtastic] Subscribe error:', err.message);
      else console.log(`[meshtastic] Subscribed to: ${topic}`);
    });
  });

  client.on('error', (err) => {
    console.error('[meshtastic] MQTT error:', err.message);
  });

  client.on('message', (_topic, message) => {
    try {
      const data = JSON.parse(message.toString()) as MeshtasticPositionPayload;

      if (data.type !== 'position' || !data.payload) return;
      const { latitude_i, longitude_i, altitude, ground_speed, ground_track, time } = data.payload;

      if (latitude_i === undefined || longitude_i === undefined) return;
      if (latitude_i === 0 && longitude_i === 0) return;

      const lat = latitude_i / 1e7;
      const lon = longitude_i / 1e7;

      // Skip obviously invalid coordinates
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

      const nodeId = data.sender || `!${data.from.toString(16).padStart(8, '0')}`;

      const pos: Position = {
        radioId: `MESH-${nodeId}`,
        callsign: nodeId,
        lat,
        lon,
        altitude: altitude ?? undefined,
        speed: ground_speed !== undefined ? ground_speed * 3.6 : undefined, // m/s → km/h
        course: ground_track !== undefined ? ground_track / 1e5 : undefined,
        timestamp: time ? new Date(time * 1000).toISOString() : new Date().toISOString(),
        source: 'meshtastic',
      };

      onPosition(pos);
    } catch {
      // Ignore non-JSON or non-position messages
    }
  });

  return () => {
    console.log('[meshtastic] Disconnecting');
    client.end(true);
  };
}
