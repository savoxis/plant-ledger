# --- build stage: compile native deps (better-sqlite3, sharp) once ---
FROM node:20-alpine AS build

# vips-dev + build tools cover sharp's native module on musl/alpine
# in case a prebuilt binary isn't available for this platform.
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime stage: no compilers, no package manager cache, non-root ---
FROM node:20-alpine

RUN apk add --no-cache vips su-exec \
    && addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY seed-data.json ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data/photos && chown -R app:app /data /app \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/plants.db
ENV PHOTOS_DIR=/data/photos

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health', r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
