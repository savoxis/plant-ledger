FROM node:20-alpine

# vips-dev + build tools cover sharp's native module on musl/alpine
# in case a prebuilt binary isn't available for this platform.
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY seed-data.json ./
COPY public ./public

RUN mkdir -p /data/photos

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/plants.db
ENV PHOTOS_DIR=/data/photos

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
