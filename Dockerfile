# ---------------------------------------------------------------------------
# Build stage: install every workspace dependency, compile server + client,
# then drop the dev dependencies so they never reach the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so this layer is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --workspaces --include-workspace-root

COPY . .

RUN npm run build && npm prune --omit=dev --workspaces --include-workspace-root

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
# The platform overrides this; 8080 is the fallback for a plain `docker run`.
ENV PORT=8080

# tini reaps zombies and, more importantly here, forwards SIGTERM so the
# server's graceful shutdown actually runs and in-flight jobs stop cleanly.
RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

# node:alpine ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
