# syntax=docker/dockerfile:1.7

# Do not add a default here. The release process must provide one immutable,
# digest-qualified Node 24 image and uses that exact image for every stage.
ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS base
ARG NODE_IMAGE
RUN NODE_IMAGE="$NODE_IMAGE" node -e 'const image = process.env.NODE_IMAGE ?? ""; if (!/^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/.test(image)) { throw new Error("NODE_IMAGE must be node:24-bookworm-slim@sha256:<64 lowercase hex digits>"); } if (process.versions.node.split(".")[0] !== "24") { throw new Error(`NODE_IMAGE resolved to Node ${process.versions.node}; Node 24 is required`); }'

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .

RUN npm run build

# This target is intentionally based on deps (and therefore the same required
# Node 24 image). By default the compiler fetches the latest MVV feed and
# compiles or keeps the scheduled artifact at the mounted output directory;
# the compiler writes the manifest last after atomically publishing its payload.
# Offline rotation remains available by passing --input with a local MVV archive.
FROM deps AS artifact-compiler
WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes unzip \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/compile-mvv-schedule.ts ./scripts/compile-mvv-schedule.ts
COPY lib ./lib
COPY tsconfig.json ./tsconfig.json
ENV NODE_OPTIONS=--conditions=react-server
ENTRYPOINT ["npm", "run", "schedule:compile:mvv", "--"]
CMD ["--output", "/output/mvv-scheduled-artifact.json"]

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp

RUN groupadd --system --gid 1001 meeet \
  && useradd --system --uid 1001 --gid meeet --home-dir /app --shell /usr/sbin/nologin meeet

COPY --from=builder --chown=meeet:meeet /app/.next/standalone ./
COPY --from=builder --chown=meeet:meeet /app/.next/static ./.next/static
COPY --from=builder --chown=meeet:meeet /app/public ./public

USER meeet
CMD ["node", "server.js"]
