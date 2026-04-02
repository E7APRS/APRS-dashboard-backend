# APRS Tracker — Backend

Node.js/TypeScript backend for real-time GPS tracking over DMR/APRS networks.  
Receives position data from multiple sources, persists to Supabase, and streams live updates via WebSocket.

## Features

- **Multi-source GPS ingestion** — APRS-IS (TCP stream), APRS.fi (HTTP polling), built-in simulator
- **Feature flags** — enable any combination of sources via a single env variable
- **Supabase persistence** — devices + position history (last 10 per radio, enforced by DB trigger)
- **In-memory cache** — fast reads for WebSocket snapshots without hitting the DB
- **WebSocket broadcast** — Socket.io pushes every new position to all connected frontends
- **REST API** — query devices, latest positions, and full history
- **Mock injector** — sends real APRS packets to APRS-IS for end-to-end pipeline testing
- **APRS.fi ToS compliance** — correct User-Agent header, exponential backoff, attribution

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + TypeScript |
| HTTP | Express |
| WebSocket | Socket.io |
| Database | Supabase (PostgreSQL) |
| Dev runner | tsx watch |

## Quick Start

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev
```

Server starts on `http://localhost:3001`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `DATA_SOURCES` | `simulator` | Comma-separated: `aprsfi`, `aprsis`, `simulator` |
| `SUPABASE_URL` | — | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role key (never expose on frontend) |
| `APRSFI_API_KEY` | — | APRS.fi API key (aprs.fi → Account) |
| `APRSFI_CALLSIGNS` | — | Comma-separated callsigns to track |
| `APRSFI_POLL_INTERVAL` | `15000` | Poll interval in ms (min 10000) |
| `APRSIS_HOST` | `rotate.aprs2.net` | APRS-IS server |
| `APRSIS_PORT` | `14580` | APRS-IS port |
| `APRSIS_CALLSIGN` | `N0CALL` | Login callsign (passcode -1 = receive-only) |
| `APRSIS_FILTER` | `p/E7` | Server-side filter ([syntax](http://www.aprs-is.net/javAPRSFilter.aspx)) |
| `SIMULATOR_INTERVAL` | `5000` | Simulator update interval in ms |
| `APRSIS_DEBUG` | — | Set to `1` to log all raw incoming packets |

### Multi-source example

```bash
DATA_SOURCES=aprsfi,aprsis,simulator
```

All three run simultaneously. Each position carries a `source` field (`aprsfi` / `aprsis` / `simulator` / `dmr`).

### APRS-IS filter examples

```bash
APRSIS_FILTER=p/E7            # All E7x callsigns (Bosnia)
APRSIS_FILTER=p/E7/9A/YU      # Bosnia + Croatia + Serbia
APRSIS_FILTER=r/43.85/18.41/100  # 100km radius around Sarajevo
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Server info + available endpoints |
| `GET` | `/api/status` | Active sources + feature flag state |
| `GET` | `/api/devices` | All known devices |
| `GET` | `/api/devices/:radioId` | Single device |
| `GET` | `/api/positions/latest` | Latest position per device |
| `GET` | `/api/positions/:radioId/history` | Position history (`?limit=500`) |
| `POST` | `/api/gps` | Manual GPS push (future DMR integration) |

### POST /api/gps payload

```json
{
  "radioId": "E70AB",
  "callsign": "E70AB",
  "lat": 43.8563,
  "lon": 18.4131,
  "altitude": 540,
  "speed": 0,
  "course": 0,
  "comment": "Base station",
  "timestamp": "2026-04-08T12:00:00Z"
}
```

## WebSocket Events

Connect to `ws://localhost:3001` with Socket.io.

| Event | Direction | Payload |
|---|---|---|
| `positions:snapshot` | server → client | `Position[]` — full current state on connect |
| `position:update` | server → client | `Position` — each new incoming position |

## Database Schema

```sql
CREATE TABLE devices (
  radio_id   TEXT        PRIMARY KEY,
  callsign   TEXT        NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL,
  last_lat   FLOAT8      NOT NULL,
  last_lon   FLOAT8      NOT NULL
);

CREATE TABLE positions (
  id         BIGSERIAL   PRIMARY KEY,
  radio_id   TEXT        NOT NULL,
  callsign   TEXT        NOT NULL,
  lat        FLOAT8      NOT NULL,
  lon        FLOAT8      NOT NULL,
  altitude   FLOAT8,
  speed      FLOAT8,
  course     FLOAT8,
  comment    TEXT,
  source     TEXT        NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

A DB trigger (`trg_trim_position_history`) automatically keeps only the last 10 positions per `radio_id`.

## Mock Injector

Sends real APRS packets to APRS-IS under your callsign — full pipeline test without a radio.

```bash
npm run mock
# or with options:
npx tsx src/scripts/mock-inject.ts --callsign E70AB --count 20 --interval 3000
```

| Flag | Default | Description |
|---|---|---|
| `--callsign` | `E70AB` | Transmitting callsign |
| `--lat` | `43.8563` | Starting latitude |
| `--lon` | `18.4131` | Starting longitude |
| `--count` | `0` (infinite) | Number of packets to send |
| `--interval` | `10000` | Interval between packets in ms |

The APRS-IS passcode is calculated automatically from the callsign.

## Project Structure

```
src/
├── index.ts              # Entry point, boot sequence
├── config.ts             # Env config + feature flags
├── types.ts              # Shared TypeScript types
├── api/
│   └── router.ts         # REST endpoints
├── services/
│   ├── store.ts          # In-memory cache + Supabase writes
│   ├── simulator.ts      # Fake GPS movement generator
│   ├── aprsfi.ts         # APRS.fi HTTP polling client
│   ├── aprsis.ts         # APRS-IS TCP stream client + parser
│   └── supabase.ts       # Supabase client singleton
├── socket/
│   └── index.ts          # Socket.io setup + broadcast
└── scripts/
    └── mock-inject.ts    # APRS-IS mock position injector
```

## License

Copyright (c) 2026 Adin Bešlagić. All rights reserved.  
Reuse permitted only with written permission from the author.  
See [LICENSE](./LICENSE) for full terms.
