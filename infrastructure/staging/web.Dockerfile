# syntax=docker/dockerfile:1
# Doctor and Admin web apps (React + Vite) behind unprivileged nginx. Build context: repository root.
# The patient app is a native mobile app and is not part of this image.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/packages/api/package.json ./packages/api/package.json
COPY frontend/apps/doctor/package.json ./apps/doctor/package.json
COPY frontend/apps/admin/package.json ./apps/admin/package.json
COPY frontend/apps/patient/package.json ./apps/patient/package.json
RUN npm ci --no-audit --no-fund -w @health-wallet/doctor -w @health-wallet/admin
COPY frontend/packages ./packages
COPY frontend/apps/doctor ./apps/doctor
COPY frontend/apps/admin ./apps/admin
RUN npm run build:doctor && npm run build:admin

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
COPY infrastructure/staging/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/apps/doctor/dist /usr/share/nginx/doctor
COPY --from=build /app/frontend/apps/admin/dist /usr/share/nginx/admin
# nginx-unprivileged already runs as uid 101; stated explicitly so the intent is visible and checked.
USER 101:101
EXPOSE 8080 8081
