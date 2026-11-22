# dota2.ai Steam retriever. Build from this directory:
#   docker build -t dota2ai-steam-retriever services/steam-retriever
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs login.mjs ./
COPY src ./src
COPY proto ./proto
COPY scripts ./scripts
# Tokens and counters live on a volume, owned by the unprivileged user.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
ENV STEAM_DATA_DIR=/data PORT=5700
VOLUME /data
EXPOSE 5700
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5700)+'/healthz').then(r=>r.json()).then(b=>process.exit(b.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
