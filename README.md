# APRS Tracker — Backend

Node.js/TypeScript backend for real-time GPS tracking over DMR/APRS networks.  
Receives position data from multiple sources, persists to Supabase, and streams live updates via WebSocket.

## Features

- **Multi-source GPS ingestion** — APRS-IS (TCP stream), APRS.fi (HTTP polling), relay (offline sync), fixed stations
- **Feature flags** — enable any combination of sources via a single env variable
- **Supabase persistence** — devices + position history with `symbol`/`symbol_table` columns
- **In-memory cache** — warmed from Supabase on startup; fast reads for WebSocket snapshots
- **WebSocket broadcast** — Socket.io pushes snapshot + trail history on connect, then live updates
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
| Dev runner | tsx |

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
| `DATA_SOURCES` | — | Comma-separated: `aprsfi`, `aprsis` |
| `SUPABASE_URL` | — | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role key (never expose on frontend) |
| `APRSFI_API_KEY` | — | APRS.fi API key (aprs.fi → Account) |
| `APRSFI_CALLSIGNS` | — | Comma-separated callsigns to track |
| `APRSFI_POLL_INTERVAL` | `15000` | Poll interval in ms (min 10000) |
| `APRSIS_HOST` | `rotate.aprs2.net` | APRS-IS server |
| `APRSIS_PORT` | `14580` | APRS-IS port |
| `APRSIS_CALLSIGN` | — | Your amateur radio callsign (required for login) |
| `APRSIS_FILTER` | `p/E7` | Server-side filter ([syntax](http://www.aprs-is.net/javAPRSFilter.aspx)) |
| `APRSIS_DEBUG` | — | Set to `1` to log all raw incoming packets |
| `RELAY_WEBHOOK_URL` | — | URL to POST new positions to (e.g. `http://localhost:3002/hook/position` for lora-relay sender) |

### APRS-IS filter examples

```bash
APRSIS_FILTER=p/E7               # All E7x callsigns (Bosnia)
APRSIS_FILTER=p/E7/9A/YU         # Bosnia + Croatia + Serbia
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
| `POST` | `/api/gps` | Manual GPS push (DMR bridge, etc.) |
| `POST` | `/api/relay` | Relay position ingest (batch, direct to store) |

### POST /api/gps payload

```json
{
  "radioId":   "E70AB",
  "callsign":  "E70AB",
  "lat":       43.8563,
  "lon":       18.4131,
  "altitude":  540,
  "speed":     0,
  "course":    0,
  "symbol":    "[",
  "comment":   "via DMR",
  "timestamp": "2026-04-09T12:00:00Z"
}
```

### POST /api/relay payload

Accepts a single position or an array of positions. Writes directly to the in-memory store and broadcasts via WebSocket — does **not** forward to APRS-IS. Used by the `lora-relay` receiver.

```json
[
  {
    "radioId": "E70AB",
    "callsign": "E70AB",
    "lat": 43.8563,
    "lon": 18.4131,
    "altitude": 540,
    "speed": 0,
    "course": 0,
    "symbol": "[",
    "comment": "via relay",
    "timestamp": "2026-04-09T12:00:00Z",
    "source": "relay"
  }
]
```

Response: `{ "status": "ok", "accepted": 1, "total": 1 }`

## WebSocket Events

Connect to `ws://localhost:3001` with Socket.io.

| Event | Direction | Payload |
|---|---|---|
| `positions:snapshot` | server → client | `Position[]` — all current positions on connect |
| `history:snapshot` | server → client | `Record<radioId, Position[]>` — trail history on connect |
| `position:update` | server → client | `Position` — each new incoming position |

## Database Schema

```sql
CREATE TABLE devices (
  radio_id   TEXT        PRIMARY KEY,
  callsign   TEXT        NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL,
  last_lat   FLOAT8,
  last_lon   FLOAT8,
  source     TEXT
);

CREATE TABLE positions (
  id           BIGSERIAL   PRIMARY KEY,
  radio_id     TEXT,
  callsign     TEXT,
  lat          FLOAT8,
  lon          FLOAT8,
  altitude     FLOAT8,
  speed        FLOAT8,
  course       FLOAT8,
  comment      TEXT,
  symbol       TEXT,
  symbol_table TEXT,
  source       TEXT,
  timestamp    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);
```
## Position History Trimming Trigger
```sql
CREATE OR REPLACE FUNCTION trim_position_history()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM positions
  WHERE radio_id = NEW.radio_id
    AND id NOT IN (
      SELECT id FROM positions
      WHERE radio_id = NEW.radio_id
      ORDER BY timestamp DESC
      LIMIT 10
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trim_position_history
AFTER INSERT ON positions
FOR EACH ROW EXECUTE FUNCTION trim_position_history();
```

Trigger `trg_trim_position_history` keeps only the last 10 positions per `radio_id`.

## Data Sources

### APRS-IS (`aprsis`)
Direct TCP connection to the APRS-IS Tier 2 network. Receives real-time position packets matching the configured server-side filter. Parses both uncompressed and compressed APRS position formats.

### APRS.fi (`aprsfi`)
Polls the APRS.fi HTTP API at a configurable interval for a fixed list of callsigns. Requires an API key (free registration at aprs.fi). ToS-compliant: correct `User-Agent`, exponential backoff on failure.

### DMR (`dmr`)
Positions arrive via `POST /api/gps` pushed by the **DMR-parser** bridge service (`DMR-parser/` in the repo root). The bridge reads DSD+ output (which decodes DMR digital audio from an HD1 radio connected via audio cable), extracts DMR-ID + GPS coordinates, resolves the callsign via RadioID.net, and posts only when GPS data is present. The `source` field on these positions is `"dmr"`.

### Relay (`relay`)
Positions arrive via `POST /api/relay` from the `lora-relay` receiver service. This is used in split deployments where the repeater site and command center are connected via an internet-independent link (LoRa 868 MHz, TCP). Relay positions are stored directly — they are not forwarded to APRS-IS.

When `RELAY_WEBHOOK_URL` is configured, the backend POSTs each new position (fire-and-forget) to the relay sender's webhook endpoint, feeding the outbound sync pipeline. This enables offline position tracking when internet is unavailable — critical for Civil Protection and disaster response scenarios.

### Fixed Stations
Statically defined in `src/services/fixed-stations.ts`. Always active regardless of `DATA_SOURCES`. Rebroadcast every 30 seconds. Used for known fixed infrastructure (repeaters, club stations).

---

## APRS Packet Parsing

`aprsis.ts` supports both APRS position formats:

**Uncompressed**: `DDMM.mmN/DDDMM.mmESymbol[CCC/SSS][comment]`

**Compressed**: `symTable + 4×base91(lat) + 4×base91(lon) + symCode + cs + T`

Both formats extract: lat, lon, symbol table (`/` or `\`), symbol code, course, speed, altitude, comment.

## Fixed Stations

Defined in `src/services/fixed-stations.ts`. Always active regardless of `DATA_SOURCES`. Broadcast every 30 seconds. Used for known infrastructure (repeaters, club stations).

## Mock Injector

Sends real APRS packets to APRS-IS under your callsign — full pipeline test without a radio.

```bash
npm run mock
# or with options:
npx tsx src/scripts/mock-inject.ts --callsign E70AB-7 --count 20 --interval 3000 --skip-timeout
```

| Flag | Default | Description |
|---|---|---|
| `--callsign` | `E70AB-7` | Transmitting callsign |
| `--lat` | `44.53808` | Starting latitude |
| `--lon` | `18.67541` | Starting longitude |
| `--count` | `0` (infinite) | Number of packets to send |
| `--interval` | `10000` | Interval between packets in ms |
| `--skip-timeout` | — | Send fixed stations immediately |

The APRS-IS passcode is calculated automatically from the callsign.

## Project Structure

```
src/
├── index.ts              # Entry point, boot sequence, relay webhook dispatch
├── config.ts             # Env config + feature flags
├── types.ts              # Shared TypeScript types
├── api/
│   └── router.ts         # REST endpoints (incl. POST /api/gps, POST /api/relay)
├── middleware/
│   └── requireAuth.ts    # JWT validation (Supabase auth tokens)
├── services/
│   ├── store.ts          # In-memory cache + Supabase writes
│   ├── aprsfi.ts         # APRS.fi HTTP polling client
│   ├── aprsis.ts         # APRS-IS TCP stream client + parser
│   ├── aprs-forwarder.ts # TCP uploader to APRS-IS (DMR → APRS gateway)
│   ├── fixed-stations.ts # Static fixed stations
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
