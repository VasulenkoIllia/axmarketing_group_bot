# ── Stage 1: compile TypeScript ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:22-alpine AS runner

# tzdata is required for TZ=Europe/Kyiv to work on Alpine
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
