import 'dotenv/config';
import { DataSource } from './types';

// DATA_SOURCES supports comma-separated list: aprsfi,aprsis
// Falls back to legacy DATA_SOURCE for backwards compatibility
const rawSources = process.env.DATA_SOURCES ?? process.env.DATA_SOURCE ?? 'aprsis';
const activeSources = rawSources.split(',').map(s => s.trim()).filter(Boolean) as DataSource[];

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),

  // Comma-separated allowed origins for CORS. Use '*' only in development.
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map(s => s.trim()),

  // Shared secret required on POST /api/gps (X-Api-Key header)
  gpsApiKey: process.env.GPS_API_KEY ?? '',

  dataSources: activeSources,

  // Local SQLite (primary database)
  sqlite: {
    path: process.env.SQLITE_PATH ?? './data/aprs.db',
  },

  // Supabase (backup database + auth provider)
  supabase: {
    url:            process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  },

  aprsfi: {
    apiKey:       process.env.APRSFI_API_KEY ?? '',
    callsigns:    (process.env.APRSFI_CALLSIGNS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    pollInterval: parseInt(process.env.APRSFI_POLL_INTERVAL ?? '15000', 10),
  },

  aprsis: {
    host:     process.env.APRSIS_HOST ?? 'rotate.aprs2.net',
    port:     parseInt(process.env.APRSIS_PORT ?? '14580', 10),
    callsign: process.env.APRSIS_CALLSIGN ?? 'N0CALL',
    filter:   process.env.APRSIS_FILTER ?? 'p/E7',
  },

  // Comment injected into every DMR position (POST /api/gps).
  // Leave empty to use whatever comment the client sends.
  dmrComment: process.env.DMR_COMMENT ?? '',

  // Relay webhook: when set, backend POSTs each new position here (fire-and-forget).
  // Used by lora-relay sender running on the same machine.
  relayWebhookUrl: process.env.RELAY_WEBHOOK_URL ?? '',

  // Meshtastic MQTT bridge
  meshtastic: {
    brokerUrl:  process.env.MESHTASTIC_MQTT_URL ?? 'mqtt://mqtt.meshtastic.org',
    topic:      process.env.MESHTASTIC_MQTT_TOPIC ?? 'msh/EU_868/2/json/#',
    username:   process.env.MESHTASTIC_MQTT_USER ?? 'meshdev',
    password:   process.env.MESHTASTIC_MQTT_PASS ?? 'large4cats',
  },

  // Generic MQTT ingestion
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL ?? '',
    topic:     process.env.MQTT_TOPIC ?? 'tracking/#',
    username:  process.env.MQTT_USERNAME ?? '',
    password:  process.env.MQTT_PASSWORD ?? '',
  },

  // Federation peers (comma-separated URLs of other E7APRS instances)
  federationPeers: (process.env.FEDERATION_PEERS ?? '').split(',').map(s => s.trim()).filter(Boolean),

  // TAK Server bridge
  tak: {
    serverHost: process.env.TAK_SERVER_HOST ?? '',
    serverPort: parseInt(process.env.TAK_SERVER_PORT ?? '8087', 10),
    enabled:    process.env.TAK_ENABLED === 'true',
  },

  // CAP alert feed
  cap: {
    feedUrl:      process.env.CAP_FEED_URL ?? '',
    pollInterval: parseInt(process.env.CAP_POLL_INTERVAL ?? '300000', 10), // 5 minutes
  },
} as const;

export const isEnabled = (source: DataSource): boolean =>
  config.dataSources.includes(source);
