FROM node:22-alpine as build

RUN mkdir /home/app
WORKDIR /home/app
COPY package.json .
RUN npm install --ignore-scripts
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=460"
RUN npm run build

FROM node:22-alpine as prod

LABEL org.opencontainers.image.source=https://github.com/Beat-All-Repo/BeatAPI
LABEL org.opencontainers.image.licenses=MIT

RUN apk add --no-cache curl
RUN addgroup -S aniwatch && adduser -S zoro -G aniwatch
RUN mkdir -p /app/public /app/dist && chown -R zoro:aniwatch /app

USER zoro
WORKDIR /app

COPY --chown=zoro:aniwatch package.json .
RUN npm install --omit=dev --ignore-scripts

COPY --from=build --chown=zoro:aniwatch /home/app/public /app/public
COPY --from=build --chown=zoro:aniwatch /home/app/dist /app/dist

# Required: server reads these at runtime via fs.readFileSync
COPY --from=build --chown=zoro:aniwatch /home/app/src/docs /app/src/docs
COPY --from=build --chown=zoro:aniwatch /home/app/endpoints/endpoints.json /app/endpoints.json
COPY --from=build --chown=zoro:aniwatch /home/app/endpoints /app/endpoints

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD [ "node", "dist/src/server.js" ]
