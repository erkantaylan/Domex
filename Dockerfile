FROM oven/bun:1.3.14-slim

# The bot needs ffmpeg to play clips.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src ./src

# The audio isn't in the image. This folder is where the server's clips volume goes.
RUN mkdir -p assets && chown bun:bun assets

USER bun

# Importing is safe to repeat: it creates missing tables and skips clips it already knows.
CMD ["sh", "-c", "bun run scripts/import-clips.ts && exec bun run src/index.ts"]
