# syntax=docker/dockerfile:1.7
# The Gilded Quill frontend: the Angular app built once, served by nginx, which also passes /api and /ws on to the backend.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
# where the backend is (the compose service name) and which DNS server finds it (Docker's own); nginx fills them into the config at start
ENV BACKEND_URL=http://backend:8080 \
    NGINX_RESOLVER=127.0.0.11
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
