FROM nginx:1.27-alpine
COPY api-gateway/nginx.conf /etc/nginx/nginx.conf
COPY openapi /usr/share/nginx/html/docs
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
