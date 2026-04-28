# ── Stage 1: Build ───────────────────────────────────────────────────
FROM node:20-alpine AS builder

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Production ─────────────────────────────────────────────
FROM node:20-alpine AS runner

# better-sqlite3 native addon needs rebuild for production
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=builder /app/dist ./dist

# Data directory for SQLite + avatars (mount a volume here)
RUN mkdir -p /data
ENV SQLITE_PATH=/data/aprs.db
ENV PORT=7531

EXPOSE 7531

CMD ["node", "dist/index.js"]
