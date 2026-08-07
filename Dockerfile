# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.13.1
ARG BUN_VERSION=1.3.13

FROM node:${NODE_VERSION}-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.10.0 --activate

WORKDIR /src
COPY . .

RUN --mount=type=cache,id=cocoa-pnpm,target=/pnpm/store \
  pnpm install \
    --frozen-lockfile \
    --ignore-scripts \
    --filter 't3...' \
    --filter '@t3tools/web...' \
    --filter '@cocoa/gateway-runtime...'

RUN pnpm --filter t3 rebuild esbuild \
  && pnpm --filter @t3tools/web build \
  && pnpm --filter t3 build:cocoa-bundle \
  && rm -rf apps/server/dist/client \
  && cp -R apps/web/dist apps/server/dist/client \
  && pnpm --config.inject-workspace-packages=true \
    --filter @cocoa/gateway-runtime \
    --prod \
    deploy \
    /opt/cocoa \
  && mkdir -p /opt/cocoa/dist \
  && cp apps/server/dist/*.mjs /opt/cocoa/dist/ \
  && cp -R apps/server/dist/client /opt/cocoa/dist/client

FROM oven/bun:${BUN_VERSION}-debian AS runtime

ARG COCOA_BUILD_IDENTITY

USER root
RUN test -n "${COCOA_BUILD_IDENTITY}" \
  && case "${COCOA_BUILD_IDENTITY}" in git:*) ;; *) exit 1 ;; esac \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 cocoa \
  && useradd \
    --uid 10001 \
    --gid 10001 \
    --home-dir /home/cocoa \
    --shell /usr/sbin/nologin \
    cocoa \
  && install -d -m 0700 -o cocoa -g cocoa /home/cocoa \
  && install -d -m 0750 -o cocoa -g cocoa \
    /data \
    /data/caches \
    /data/userdata \
    /data/userdata/logs \
    /data/worktrees

COPY --from=build --chown=10001:10001 /opt/cocoa /opt/cocoa
COPY --chown=10001:10001 --chmod=0640 \
  docker/settings.json \
  /data/userdata/settings.json

ENV HOME=/home/cocoa \
  T3CODE_RUNTIME_PROFILE=cocoa-gateway \
  T3CODE_HOST=0.0.0.0 \
  T3CODE_PORT=7331 \
  T3CODE_HOME=/data \
  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false \
  T3CODE_NO_BROWSER=true \
  COCOA_BUILD_IDENTITY=${COCOA_BUILD_IDENTITY}

LABEL xyz.brbc.cocoa.build-identity=${COCOA_BUILD_IDENTITY}

WORKDIR /data
USER 10001:10001
EXPOSE 7331
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:7331/readyz');if(!r.ok)process.exit(1)"]

ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/cocoa/dist/cocoa-bin.mjs"]
