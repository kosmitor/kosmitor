# syntax=docker/dockerfile:1
# Kosmitor: one image serves the API and the built web app, and doubles as the
# backup / restore-drill job (it carries the PostgreSQL client tools).

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages ./packages
COPY apps ./apps
# The web build loads the settings module, and vite preview reads the param files.
COPY kosmitor.config*.json ./
RUN npm run build

FROM node:26-alpine AS runtime
RUN apk add --no-cache postgresql17-client tini
ENV NODE_ENV=production PORT=4000 WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace=@ct/server --workspace=@ct/core --include-workspace-root=false \
 && npm cache clean --force
COPY packages/core/src ./packages/core/src
COPY apps/server/src ./apps/server/src
# The param file, its schema, and kosmitor.config.local.json when there is one.
COPY kosmitor.config*.json ./
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/src/index.ts"]
