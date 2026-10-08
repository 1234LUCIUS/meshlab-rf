#!/usr/bin/env node
/* =========================================================================
   MeshLab RF — serveur web statique, sans aucune dépendance
   ---------------------------------------------------------------------
   Le simulateur tourne entièrement dans le navigateur : ce serveur ne fait
   que distribuer les fichiers du dossier.

   Démarrage :   node server.js            (http://localhost:8080)
   Variables :   PORT (8080) · HOST (0.0.0.0) · QUIET=1 (pas de journal)
                 CSP=off (désactive l'en-tête Content-Security-Policy)
   ========================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8076;
const HOST = process.env.HOST || '0.0.0.0';
const QUIET = process.env.QUIET === '1';

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2', '.woff':'font/woff',
  '.txt':'text/plain; charset=utf-8', '.map':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json'
};
// fichiers jamais servis : dossier de sauvegarde, dépendances, fichiers cachés, archives
const BLOCKED = [/^original\//, /^node_modules\//, /(^|\/)\./, /\.(rar|zip|7z|log)$/i,
  /^(server\.js|package(-lock)?\.json|Dockerfile|docker-compose\.ya?ml|README\.md)$/i];

// Domaines contactés par le simulateur depuis le navigateur (relief, cartes, OpenStreetMap, IGN, bibliothèques).
// Tout ajout de source de données doit être déclaré ici, sinon le navigateur la bloquera.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https://s3.amazonaws.com https://server.arcgisonline.com https://*.tile.openstreetmap.org https://*.tile.opentopomap.org",
  "connect-src 'self' https://s3.amazonaws.com https://overpass-api.de https://maps.mail.ru https://overpass.private.coffee https://data.geopf.fr",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'"
].join('; ');

const gzipCache = new Map();   // chemin+mtime -> Buffer compressé

function securityHeaders(res){
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if(process.env.CSP !== 'off') res.setHeader('Content-Security-Policy', CSP);
}

function send(res, status, body, headers){
  res.writeHead(status, Object.assign({'Content-Type':'text/plain; charset=utf-8'}, headers||{}));
  res.end(body);
}

function resolveFile(urlPath){
  let rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if(rel.endsWith('/')) rel += 'index.html';
  rel = rel.replace(/^\/+/, '');
  if(rel === '') rel = 'index.html';
  const full = path.resolve(ROOT, rel);
  // interdit de sortir du dossier (../) ou de lire un fichier masqué
  if(full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  const relFinal = path.relative(ROOT, full).split(path.sep).join('/');
  if(BLOCKED.some(re => re.test(relFinal))) return null;
  return {full, rel: relFinal};
}

function serve(req, res, file){
  let st;
  try { st = fs.statSync(file.full); } catch(e) { return send(res, 404, 'Fichier introuvable\n'); }
  if(st.isDirectory()) return serve(req, res, {full: path.join(file.full,'index.html'), rel: file.rel+'/index.html'});

  const ext = path.extname(file.full).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';
  // HTML, JS et CSS : revalidation à chaque visite pour qu'une mise à jour parte tout de suite.
  // Images et polices : cache d'un jour.
  const cache = /\.(html|js|css|json)$/i.test(ext) ? 'no-cache' : 'public, max-age=86400';

  securityHeaders(res);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', st.mtime.toUTCString());
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Type', type);

  if(req.headers['if-none-match'] === etag){ res.writeHead(304); return res.end(); }

  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /^(text\/|application\/(json|javascript|manifest))/.test(type) && st.size > 1024;
  if(req.method === 'HEAD'){
    res.setHeader('Content-Length', st.size);
    res.writeHead(200); return res.end();
  }
  if(wantsGzip){
    const key = file.full + ':' + st.mtimeMs;
    let buf = gzipCache.get(key);
    if(!buf){
      buf = zlib.gzipSync(fs.readFileSync(file.full), {level: 6});
      gzipCache.clear();               // une seule version en mémoire par fichier modifié
      gzipCache.set(key, buf);
    }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', buf.length);
    res.writeHead(200);
    return res.end(buf);
  }
  res.setHeader('Content-Length', st.size);
  res.writeHead(200);
  fs.createReadStream(file.full).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  res.on('finish', () => { if(!QUIET) console.log(`${new Date().toISOString()} ${req.method} ${req.url} → ${res.statusCode} (${Date.now()-t0} ms)`); });

  if(req.method !== 'GET' && req.method !== 'HEAD'){
    securityHeaders(res);
    return send(res, 405, 'Méthode non autorisée\n', {'Allow':'GET, HEAD'});
  }
  if(req.url === '/healthz'){ securityHeaders(res); return send(res, 200, 'ok\n'); }

  const file = resolveFile(req.url);
  if(!file){ securityHeaders(res); return send(res, 403, 'Accès refusé\n'); }
  serve(req, res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`MeshLab RF servi sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (dossier : ${ROOT})`);
});
for(const sig of ['SIGINT','SIGTERM']) process.on(sig, () => { console.log('\nArrêt du serveur.'); server.close(() => process.exit(0)); });
