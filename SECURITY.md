# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this project, please report it responsibly by emailing:

**Email:** beslagicadin@gmail.com

Please do **NOT** create a public GitHub issue for security vulnerabilities. You will receive a response within 72 hours acknowledging receipt.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## License

This software is proprietary. All rights reserved by Adin Beslagic. Any use, modification, or distribution requires prior written permission from the author. See the [LICENSE](LICENSE) file for full terms.

To request permission, contact: beslagicadin@gmail.com

## Environment Variables & Secrets

**NEVER commit `.env` files to version control.**

Use the provided template to create your local configuration:

```bash
cp .env.example .env
```

### Sensitive Variables

| Variable | Risk | Notes |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **CRITICAL** | Full admin access to Supabase — never expose on frontend or in logs |
| `GPS_API_KEY` | HIGH | Shared secret for `POST /api/gps` and `POST /api/relay` ingest endpoints |
| `APRSFI_API_KEY` | MEDIUM | Personal APRS.fi API key — rate-limited and tied to your account |
| `SQLITE_PATH` | MEDIUM | Local database file — ensure proper filesystem permissions |

### Rules

- `SUPABASE_SERVICE_ROLE_KEY` must **never** appear in frontend code, browser network requests, or log output
- `GPS_API_KEY` should be a strong random string in production (minimum 32 characters)
- Rotate all API keys before first production deployment and on a regular schedule

## Authentication & Authorization

- **Supabase Auth** handles user authentication (email/password + Google OAuth)
- Backend validates JWT tokens via Supabase `auth.getUser()` on every protected route
- `POST /api/gps` and `POST /api/relay` use `X-Api-Key` header authentication instead of JWT
- WebSocket connections are authenticated during the handshake — unauthenticated sockets are rejected

### Production Checklist

- [ ] Ensure `GPS_API_KEY` is set (empty = auth disabled, development only)
- [ ] Verify JWT validation is active on all `/api` routes
- [ ] Confirm WebSocket auth middleware rejects invalid tokens

## API Security

### Input Validation

- `POST /api/gps` and `POST /api/relay` validate required fields (`radioId`, `callsign`, `lat`, `lon`)
- Request body is limited to 5 MB (`express.json({ limit: '5mb' })`)
- SQL parameters are always bound (never interpolated) in SQLite queries

### CORS

- Allowed origins are configured via `CORS_ORIGINS` environment variable
- **Production:** restrict to your exact frontend domain(s) only
- **Development:** defaults to `http://localhost:3000`

### Rate Limiting

- APRS.fi polling respects rate limits with exponential backoff
- **Production:** implement rate limiting on `POST /api/gps` to prevent abuse

## Database Security

### Local SQLite (Primary)

- Database file should have restrictive filesystem permissions (`chmod 600`)
- Located at `SQLITE_PATH` (default: `./data/aprs.db`)
- All queries use parameterized statements — no SQL injection risk
- Position history is bounded by triggers to prevent unbounded growth

### Supabase (Backup)

- Backend uses `service_role` key — bypasses Row Level Security
- All Supabase writes are fire-and-forget (non-blocking, best-effort)
- Never use the `service_role` key on the frontend — use `anon` key there

## WebSocket Security

- Socket.io authenticates via `socket.handshake.auth.token`
- Invalid or expired tokens result in connection rejection
- Clients receive a full state snapshot on connect — no stale data

## Production Deployment Checklist

- [ ] Set strong `GPS_API_KEY` (32+ random characters)
- [ ] Set `SUPABASE_SERVICE_ROLE_KEY` via secrets manager (not `.env` on disk)
- [ ] Restrict `CORS_ORIGINS` to production frontend URL only
- [ ] Enable HTTPS for all endpoints (terminate TLS at reverse proxy)
- [ ] Set restrictive filesystem permissions on SQLite database file
- [ ] Implement rate limiting on public-facing ingest endpoints
- [ ] Disable `APRSIS_DEBUG` in production (leaks raw packet data to logs)
- [ ] Review and rotate all API keys on a regular schedule
- [ ] Set up monitoring and alerting for failed auth attempts
- [ ] Keep all dependencies up to date (`npm audit`)

## Third-Party Services

| Service | Usage | Security Notes |
|---|---|---|
| **Supabase** | Auth + backup database | Use `service_role` key only on backend |
| **APRS.fi** | Position polling | API key is personal, respect ToS rate limits |
| **APRS-IS** | TCP position stream | Receive-only by default (`passcode -1`) |

## Dependency Management

- Run `npm audit` regularly and address vulnerabilities promptly
- Pin major dependency versions in `package.json`
- Review changelogs before upgrading `express`, `socket.io`, `better-sqlite3`, and `@supabase/supabase-js`
