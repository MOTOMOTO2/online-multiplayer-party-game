# Bluffalo - single-process Node server (static client + WebSocket game loop)
FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# Install deps first so this layer caches between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 8080
CMD ["node", "server/index.js"]
