# Ream — Production Dockerfile (no Rust toolchain needed)
# NAPI binaries are prebuilt by CI and bundled in npm packages.
#
# This Dockerfile is a TEMPLATE for user applications created with create-ream.
# Copy it to your project root and adjust as needed.
#
# @implements FR80

FROM node:22-slim AS base
RUN corepack enable pnpm
WORKDIR /app

# --- Dependencies ---
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- Build ---
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY app/ ./app/
COPY bin/ ./bin/
COPY config/ ./config/
COPY providers/ ./providers/
COPY start/ ./start/
COPY reamrc.ts ./
COPY env.ts ./
RUN pnpm build

# --- Production ---
FROM base AS production
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))"

EXPOSE 3000

CMD ["node", "dist/bin/server.js"]
