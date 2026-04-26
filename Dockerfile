# build stage for building .ts files
FROM node:22-alpine as build

RUN mkdir /home/app

WORKDIR /home/app

COPY package.json .

RUN npm install --ignore-scripts

COPY . .

# Prevents OOM crash during TypeScript compilation on Render free tier (512MB RAM)
ENV NODE_OPTIONS="--max-old-space-size=460"

RUN npm run build

# prod stage for including only necessary files
FROM node:22-alpine as prod

LABEL org.opencontainers.image.source=https://github.com/Beat-All-Repo/BeatAPI
LABEL org.opencontainers.image.description="BeatAPI - Unified Anime API"
LABEL org.opencontainers.image.licenses=MIT

# install curl for healthcheck
RUN apk add --no-cache curl

# create a non-privileged user
RUN addgroup -S aniwatch && adduser -S zoro -G aniwatch

# set secure folder permissions
RUN mkdir -p /app/public /app/dist && chown -R zoro:aniwatch /app

# set non-privileged user
USER zoro

# set working directory
WORKDIR /app

# copy config file for better use of layers
COPY --chown=zoro:aniwatch package.json .

# install dependencies
RUN npm install --omit=dev --ignore-scripts

# copy public folder from build stage to prod
COPY --from=build --chown=zoro:aniwatch /home/app/public /app/public

# copy dist folder from build stage to prod
COPY --from=build --chown=zoro:aniwatch /home/app/dist /app/dist

# FIXED: ping localhost (not api.tatakai.me) so the check actually tests YOUR server
# Longer start-period gives the app time to boot on slow free-tier hardware
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

ENV NODE_ENV=production
ENV PORT=4000

# exposed port
EXPOSE 4000

CMD [ "node", "dist/src/server.js" ]
