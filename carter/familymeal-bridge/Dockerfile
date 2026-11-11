FROM node:24-alpine
WORKDIR /app
COPY data ./data
COPY public ./public
COPY src ./src
USER node
ENV NODE_ENV=production DB_PATH=/data/bridge.db
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
