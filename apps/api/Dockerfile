# SideStage API — built from the repo root context (workspaces + libs needed).
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
  && npm run build --workspace @papercusp/typesense \
  && npm run build --workspace @papercusp/sidestage-api \
  && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/libs/typesense/dist ./libs/typesense/dist
COPY --from=build /app/libs/typesense/package.json ./libs/typesense/package.json
COPY --from=build /app/package.json ./package.json
# Bake the deployed git sha in as the LAST layer: it changes every deploy, so
# declaring it earlier would invalidate the cache for every COPY above it.
# Surfaced at /healthz so .deployed-sha can be verified against what is running.
ARG SIDESTAGE_SHA=unknown
ENV SIDESTAGE_SHA=$SIDESTAGE_SHA
EXPOSE 3100
CMD ["node", "apps/api/dist/main.js"]
