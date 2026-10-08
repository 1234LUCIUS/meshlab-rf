# Image minimale : le simulateur est statique, le serveur Node n'a aucune dépendance
FROM node:22-alpine

WORKDIR /app
COPY index.html geo.js engine.js workspace.js app.js server.js package.json ./
COPY cr.html ./

ENV PORT=8765 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8765
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1

CMD ["node", "server.js"]
