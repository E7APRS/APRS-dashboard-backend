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
} as const;

export const isEnabled = (source: DataSource): boolean =>
  config.dataSources.includes(source);
