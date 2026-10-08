# Image minimale : le simulateur est statique, le serveur Node n'a aucune dépendance
FROM node:22-alpine

WORKDIR /app
COPY index.html geo.js engine.js app.js server.js package.json ./
COPY cr.html ./

ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
