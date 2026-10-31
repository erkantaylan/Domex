FROM oven/bun:1.3.14-slim

# The bot needs ffmpeg to play clips.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# assets/ holds the audio, so this image must stay private.
COPY tsconfig.json ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src ./src
COPY assets ./assets

USER bun

# Importing is safe to repeat: it creates missing tables and skips clips it already knows.
CMD ["sh", "-c", "bun run scripts/import-clips.ts && exec bun run src/index.ts"]
