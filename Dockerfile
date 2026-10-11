# syntax=docker/dockerfile:1

# Base image is overridable, e.g. the AWS ECR Public mirror of Docker Hub's image:
#   docker build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim .
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- Stage 1: install production dependencies ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Build tools are only a fallback in case no prebuilt better-sqlite3 binary
# matches; they stay in this stage and never reach the final image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- Stage 2: minimal runtime ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MOCK_STORAGE_DIR=/data/mock_storage
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# /data holds the SQLite database and the generated .master.key.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as the unprivileged "node" user (uid 1000) that ships with the image.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
