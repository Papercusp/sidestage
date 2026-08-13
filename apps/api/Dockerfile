# SideStage API — built from the repo root context (workspaces + libs needed).
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
  && npm run build --workspace @papercusp/sidestage-api \
  && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/package.json ./package.json
EXPOSE 3100
CMD ["node", "apps/api/dist/main.js"]
