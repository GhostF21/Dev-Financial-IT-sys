FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
ARG NPM_CONFIG_STRICT_SSL=true
RUN npm ci --omit=dev --no-audit --no-fund --strict-ssl=${NPM_CONFIG_STRICT_SSL}

COPY src ./src

RUN addgroup -S app && adduser -S app -G app
USER app

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
