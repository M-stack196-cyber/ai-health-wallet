# syntax=docker/dockerfile:1
# Node.js API. Build context: repository root.  docker build -f infrastructure/staging/backend.Dockerfile .
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production PORT=5000
WORKDIR /app/backend
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./package.json
COPY backend/migrations ./migrations
COPY infrastructure/staging/load-secrets.sh /usr/local/bin/load-secrets.sh
# Code and migrations are owned by root and read-only to the service user.
USER node
EXPOSE 5000
ENTRYPOINT ["/usr/local/bin/load-secrets.sh"]
CMD ["node", "dist/server.js"]
