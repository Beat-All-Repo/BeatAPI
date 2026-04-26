# ─────────────────────────────────────────────
#  Stage 1: Build
# ─────────────────────────────────────────────
FROM node:22-alpine AS build

RUN apk add --no-cache libc6-compat python3 make g++

RUN mkdir /home/app
WORKDIR /home/app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
ENV NODE_OPTIONS="--max-old-space-size=400"
RUN npm run build

# ─────────────────────────────────────────────
#  Stage 2: Production
# ─────────────────────────────────────────────
FROM node:22-alpine AS prod

LABEL org.opencontainers.image.source=https://github.com/Beat-All-Repo/BeatAPI
LABEL org.opencontainers.image.licenses=MIT

RUN apk add --no-cache curl libc6-compat

RUN addgroup -S aniwatch && adduser -S zoro -G aniwatch
RUN mkdir -p /app/public /app/dist /app/src/docs && chown -R zoro:aniwatch /app

USER zoro
WORKDIR /app

ENV NODE_ENV=production
ENV ANIWATCH_API_PORT=10000
ENV PORT=10000

COPY --chown=zoro:aniwatch package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build --chown=zoro:aniwatch /home/app/public /app/public
COPY --from=build --chown=zoro:aniwatch /home/app/dist /app/dist

# Required: server reads these at runtime via fs.readFileSync
COPY --from=build --chown=zoro:aniwatch /home/app/src/docs /app/src/docs
COPY --from=build --chown=zoro:aniwatch /home/app/endpoints/endpoints.json /app/endpoints.json
COPY --from=build --chown=zoro:aniwatch /home/app/endpoints /app/endpoints

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:10000/health || exit 1

EXPOSE 10000

CMD ["sh", "-c", "\
  if [ -f dist/server.js ]; then \
    exec node dist/server.js; \
  elif [ -f dist/src/server.js ]; then \
    exec node dist/src/server.js; \
  else \
    echo 'ERROR: Cannot find compiled entry point.' && exit 1; \
  fi \
"]
