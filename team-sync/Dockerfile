# ---------------------------------------------------------------------------
# Base stage — shared setup
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install -g npm@latest

# ---------------------------------------------------------------------------
# Dev stage — all deps including tsx for local development
# ---------------------------------------------------------------------------
FROM base AS dev
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
# Builder stage — compile TypeScript
# ---------------------------------------------------------------------------
FROM base AS builder
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage — production only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install -g npm@latest && npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]