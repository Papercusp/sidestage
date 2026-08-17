# SideStage zero-cache — the WebSocket sync server (Rocicorp Zero).
#
# Serves the view-syncer on :4848, which is what @papercusp/sync's
# WebSocketAdapter connects to. Replicates from Postgres via logical
# replication (publication `zero_publication`, created by db/zero-publication.sql)
# into a local SQLite replica on the /data/zero volume.
#
# Built from the REPO ROOT context so package-lock.json is available:
#   docker build -f infra/zero/Dockerfile -t sidestage-zero-cache:latest .
#
# --- why node:22 -------------------------------------------------------------
# @rocicorp/zero 1.8.0 declares engines.node ">=22". The other SideStage images
# (apps/api, apps/web) are node:20-alpine — do NOT align this one down to match
# them; zero-cache will not run on 20.
FROM node:22-alpine
WORKDIR /app

# --- version pin -------------------------------------------------------------
# The zero-cache SERVER must stay version-matched to the @rocicorp/zero CLIENT
# bundled into apps/web. A bare `npm install @rocicorp/zero` floats to latest on
# every rebuild; on Restart that silently skewed prod to 1.5.0 against a locked
# 1.3.0 client and produced a change-streamer crashloop. So the version is
# DERIVED from the committed lockfile, which makes the server follow the client
# automatically whenever the pin is bumped deliberately.
#
# Only the lockfile is copied: zero-cache needs the `zero-cache` binary and
# nothing else from this monorepo (queries and mutations are delegated over
# ZERO_QUERY_URL / ZERO_MUTATE_URL to the API). Installing it standalone also
# avoids resolving the apps/* and libs/* workspaces, which are not present in
# this image.
COPY package-lock.json ./
RUN ZERO_VERSION="$(node -e "process.stdout.write(require('./package-lock.json').packages['node_modules/@rocicorp/zero'].version)")" \
 && test -n "$ZERO_VERSION" \
 && echo "Pinning @rocicorp/zero to lockfile version: ${ZERO_VERSION}" \
 && npm init -y > /dev/null \
 && npm install --no-audit --no-fund "@rocicorp/zero@${ZERO_VERSION}" \
 && test -x node_modules/.bin/zero-cache \
 && INSTALLED="$(node -p "require('./node_modules/@rocicorp/zero/package.json').version")" \
 && echo "Installed @rocicorp/zero: ${INSTALLED} (lockfile: ${ZERO_VERSION})" \
 && test "$INSTALLED" = "$ZERO_VERSION"

# Persistent SQLite replica + change log. Size this volume for the published
# set: measured 3476 MB across the 19 tables of `zero_publication` on
# 2026-08-17 (product_catalog 2637 MB, storefront_product 836 MB), so allow
# several GB of headroom for the replica plus its WAL.
RUN mkdir -p /data/zero
VOLUME ["/data/zero"]

ENV NODE_ENV=production
# 4848 = view-syncer WebSocket port (browsers connect here, via Traefik)
# 4849 = replication-manager port (internal)
EXPOSE 4848 4849

# The healthcheck interval is load-bearing, not cosmetic: zero-dispatcher
# self-drains (exits 0) if it sees no /keepalive heartbeat within ~20s. Docker's
# 30s default interval is therefore SLOWER than the drain timeout and makes the
# container exit-and-restart forever. Keep this well under 20s.
HEALTHCHECK --interval=5s --timeout=3s --start-period=180s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:4848/keepalive || exit 1

# ⚠ This execs the binary DIRECTLY — scripts/zero-cache-start.sh is NOT the
# entrypoint here, and must not become one. That script is a DEV launcher: it ends
# in `exec npx zero-cache-dev` (one process, the wrong shape for production), kills
# replica-lock holders with fuser, and defaults to a dev database URL.
#
# Its two genuinely production-relevant preflights — upstream wal_level must be
# `logical`, and the live publication must match db/zero-publication.sql — are
# therefore NOT run by this container. They live in scripts/zero-replication-apply.sh
# instead, which deploy/deploy.sh runs on prod after `compose up -d` and before the
# health gate. If you are wondering why a replication fault was not caught at
# container start: by design, it is caught one step earlier, at deploy time.
# (WI-39712. Guarded by deploy/zero-replication-apply.test.mjs.)
CMD ["node_modules/.bin/zero-cache"]
