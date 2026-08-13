# SideStage web — Vite build served as static files by nginx.
# VITE_API_URL / VITE_MEDIAMTX_URL are baked at build time (Vite inlines them).
FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=/api
ARG VITE_MEDIAMTX_URL=
ENV VITE_API_URL=$VITE_API_URL VITE_MEDIAMTX_URL=$VITE_MEDIAMTX_URL
COPY . .
RUN npm ci --no-audit --no-fund \
  && npm run build --workspace @papercusp/sidestage-web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
