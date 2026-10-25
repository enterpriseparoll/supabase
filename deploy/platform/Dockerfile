FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY apps/control-plane/package*.json ./
RUN npm ci --ignore-scripts
COPY apps/control-plane/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
RUN apk add --no-cache docker-cli docker-cli-compose restic ca-certificates iptables
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY docker/ /opt/platform/docker/
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
