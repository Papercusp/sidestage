# SideStage API — built from the repo root context (workspaces + libs needed).
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
  && npm run build --workspace @papercusp/system-test-contract \
  && npm run build --workspace @papercusp/system-test-runner \
  && npm run build --workspace @papercusp/scout-runtime \
  && npm run build --workspace @papercusp/sse \
  && npm run build --workspace @papercusp/typesense \
  && npm run build --workspace @papercusp/sidestage-zero \
  && npm run build --workspace @papercusp/sidestage-api \
  && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/libs/system-test-contract/dist ./libs/system-test-contract/dist
COPY --from=build /app/libs/system-test-contract/package.json ./libs/system-test-contract/package.json
COPY --from=build /app/libs/system-test-runner/dist ./libs/system-test-runner/dist
COPY --from=build /app/libs/system-test-runner/package.json ./libs/system-test-runner/package.json
COPY --from=build /app/libs/scout-runtime/dist ./libs/scout-runtime/dist
COPY --from=build /app/libs/scout-runtime/package.json ./libs/scout-runtime/package.json
COPY --from=build /app/libs/sse/dist ./libs/sse/dist
COPY --from=build /app/libs/sse/package.json ./libs/sse/package.json
COPY --from=build /app/libs/typesense/dist ./libs/typesense/dist
COPY --from=build /app/libs/typesense/package.json ./libs/typesense/package.json
COPY --from=build /app/libs/zero/dist ./libs/zero/dist
COPY --from=build /app/libs/zero/package.json ./libs/zero/package.json
COPY --from=build /app/package.json ./package.json
# Bake the deployed git sha in as the LAST layer: it changes every deploy, so
# declaring it earlier would invalidate the cache for every COPY above it.
# Surfaced at /healthz so .deployed-sha can be verified against what is running.
ARG SIDESTAGE_SHA=unknown
ENV SIDESTAGE_SHA=$SIDESTAGE_SHA
EXPOSE 3100
CMD ["node", "apps/api/dist/main.js"]
