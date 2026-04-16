/**
 * Generic MQTT ingestion — subscribes to configurable MQTT topics and
 * normalizes JSON payloads into Position objects.
 *
 * Expects JSON payloads with at minimum: latitude/lat, longitude/lon.
 * Optional: altitude, speed, course, callsign, id/deviceId.
 */
import mqtt from 'mqtt';
import { config } from '../config';
import { Position } from '../types';

function extractPosition(data: Record<string, unknown>, topic: string): Position | null {
  const lat = (data.latitude ?? data.lat) as number | undefined;
  const lon = (data.longitude ?? data.lon ?? data.lng) as number | undefined;

  if (lat === undefined || lon === undefined) return null;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const id = (data.deviceId ?? data.device_id ?? data.id ?? data.dev_eui ?? data.devEUI) as string | undefined;
  const callsign = (data.callsign ?? data.name ?? id ?? 'MQTT') as string;
  const radioId = `MQTT-${id ?? callsign}`;

  return {
    radioId,
    callsign: String(callsign),
    lat,
    lon,
    altitude: typeof data.altitude === 'number' ? data.altitude : undefined,
    speed: typeof data.speed === 'number' ? data.speed : undefined,
    course: typeof data.course === 'number' ? data.course : (typeof data.heading === 'number' ? data.heading as number : undefined),
    comment: typeof data.comment === 'string' ? data.comment : undefined,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
    source: 'mqtt',
  };
}

export function startMqttSource(onPosition: (pos: Position) => void): () => void {
  const { brokerUrl, topic, username, password } = config.mqtt;

  if (!brokerUrl) {
    console.log('[mqtt] No MQTT_BROKER_URL configured, skipping');
    return () => {};
  }

  console.log(`[mqtt] Connecting to ${brokerUrl}, topic: ${topic}`);

  const client = mqtt.connect(brokerUrl, {
    username: username || undefined,
    password: password || undefined,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log('[mqtt] Connected to MQTT broker');
    client.subscribe(topic, (err) => {
      if (err) console.error('[mqtt] Subscribe error:', err.message);
      else console.log(`[mqtt] Subscribed to: ${topic}`);
    });
  });

  client.on('error', (err) => {
    console.error('[mqtt] MQTT error:', err.message);
  });

  client.on('message', (msgTopic, message) => {
    try {
      const data = JSON.parse(message.toString());

      // Handle ChirpStack/TTN uplink format (nested object_json or decoded_payload)
      const payload = data.object ?? data.decoded_payload ?? data.uplink_message?.decoded_payload ?? data;

      const pos = extractPosition(payload as Record<string, unknown>, msgTopic);
      if (pos) onPosition(pos);
    } catch {
      // Ignore non-JSON messages
    }
  });

  return () => {
    console.log('[mqtt] Disconnecting');
    client.end(true);
  };
}
