#!/usr/bin/env node
/* =========================================================================
   MeshLab RF — serveur web statique, sans aucune dépendance
   ---------------------------------------------------------------------
   Le simulateur tourne entièrement dans le navigateur : ce serveur ne fait
   que distribuer les fichiers du dossier.

   Démarrage :   node server.js            (http://localhost:8765)
   Variables :   PORT (8765) · HOST (0.0.0.0) · QUIET=1 (pas de journal console)
                 CSP=off (désactive l'en-tête Content-Security-Policy)
                 ACCESS_LOG=chemin (journal des accès dans un fichier)
                 TRUST_PROXY=1 (nombre de proxys de confiance devant le serveur,
                 pour lire l'adresse réelle du visiteur dans X-Forwarded-For)
                 OVERPASS=off · OVERPASS_MIRRORS=url1,url2
   ========================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '0.0.0.0';
const QUIET = process.env.QUIET === '1';

/* ---------------------------------------------------------------------
   Journal des accès
   Derrière un reverse proxy (nginx, Caddy, Cloudflare), l'adresse vue par
   Node est celle du proxy : la vraie adresse du visiteur se trouve dans
   X-Forwarded-For. Cet en-tête étant falsifiable par n'importe qui, on ne
   le lit que si TRUST_PROXY annonce combien de proxys sont devant nous.
   nginx avec $proxy_add_x_forwarded_for ajoute l'adresse qu'il voit à la
   fin de la liste : avec TRUST_PROXY=1 c'est cette dernière entrée qui est
   la bonne. Deux proxys en cascade (Cloudflare puis nginx) : TRUST_PROXY=2.
--------------------------------------------------------------------- */
const TRUST_PROXY = (() => {
  const v = process.env.TRUST_PROXY;
  if(!v) return 0;
  if(v === 'true' || v === 'yes') return 1;
  return Math.max(0, Number(v) || 0);
})();
const ACCESS_LOG = process.env.ACCESS_LOG || '';
const VISIT_WINDOW_MS = 30 * 60 * 1000;   // au-delà, on compte une nouvelle visite
const lastSeen = new Map();               // adresse -> instant de la dernière requête

function normIp(ip){
  if(!ip) return '?';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;   // IPv4 encapsulée en IPv6
}
function clientIp(req){
  const peer = normIp(req.socket.remoteAddress);
  if(!TRUST_PROXY) return peer;
  const xff = req.headers['x-forwarded-for'];
  if(xff){
    const list = String(xff).split(',').map(x => x.trim()).filter(Boolean);
    const ip = list[list.length - TRUST_PROXY];   // on remonte d'autant de maillons qu'il y a de proxys
    if(ip) return normIp(ip);
  }
  const real = req.headers['x-real-ip'];
  if(real) return normIp(String(real).trim());
  return peer;
}

let logStream = null, logWarned = false;
function writeLog(line){
  if(!QUIET) console.log(line);
  if(!ACCESS_LOG) return;
  try {
    if(!logStream) logStream = fs.createWriteStream(ACCESS_LOG, {flags:'a'});
    logStream.write(line + '\n');
  } catch(e){
    if(!logWarned){ logWarned = true; console.error(`Journal des accès impossible (${ACCESS_LOG}) : ${e.message}`); }
  }
}
// Une ligne par requête, précédée d'une ligne VISITE la première fois qu'une
// adresse apparaît (ou après 30 min d'inactivité) : de quoi repérer les
// visiteurs sans avoir à lire toutes les requêtes de fichiers.
function logRequest(req, res, ip, ms){
  const now = Date.now(), t = new Date(now).toISOString();
  const prev = lastSeen.get(ip);
  lastSeen.set(ip, now);
  if(lastSeen.size > 5000) for(const [k, v] of lastSeen) if(now - v > VISIT_WINDOW_MS) lastSeen.delete(k);
  if(prev === undefined || now - prev > VISIT_WINDOW_MS){
    const ua = (req.headers['user-agent'] || '?').slice(0, 160);
    const ref = req.headers['referer'] ? ` <- ${String(req.headers['referer']).slice(0, 120)}` : '';
    writeLog(`${t} VISITE ${ip} ${req.url}${ref}  "${ua}"`);
  }
  writeLog(`${t} ${ip} ${req.method} ${req.url} -> ${res.statusCode} (${ms} ms)`);
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2', '.woff':'font/woff',
  '.txt':'text/plain; charset=utf-8', '.map':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json'
};
// fichiers jamais servis : dossier de sauvegarde, dépendances, fichiers cachés, archives
const BLOCKED = [/^original\//, /^backup\//, /^node_modules\//, /(^|\/)\./, /\.(rar|zip|7z|log)$/i,
  /^(server\.js|ecosystem\.config\.js|package(-lock)?\.json|Dockerfile|docker-compose\.ya?ml|README\.md)$/i];

// Domaines contactés par le simulateur depuis le navigateur (relief, cartes, OpenStreetMap, IGN, bibliothèques).
// Tout ajout de source de données doit être déclaré ici, sinon le navigateur la bloquera.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https://cdnjs.cloudflare.com https://s3.amazonaws.com https://server.arcgisonline.com https://*.tile.openstreetmap.org https://*.tile.opentopomap.org",
  "connect-src 'self' https://s3.amazonaws.com https://overpass-api.de https://maps.mail.ru https://overpass.kumi.systems https://overpass.private.coffee https://data.geopf.fr",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'"
].join('; ');

const gzipCache = new Map();   // chemin+mtime -> Buffer compressé

/* ---------------------------------------------------------------------
   Relais Overpass (/api/overpass)
   Les serveurs Overpass publics sont irréguliers : saturés, et parfois
   en panne au point de renvoyer une erreur sans en-tête CORS, que le
   navigateur refuse alors de lire. Relayer la requête depuis le serveur
   supprime le problème : aucune règle CORS ne s'applique de serveur à
   serveur, et on peut essayer les miroirs l'un après l'autre.
   Se désactive avec OVERPASS=off ; miroirs réglables avec OVERPASS_MIRRORS.
--------------------------------------------------------------------- */
const OVERPASS_ON = process.env.OVERPASS !== 'off';
// Ordre établi d'après l'état réel des instances publiques, vérifié en interrogeant
// une zone boisée française et en comptant les polygones renvoyés :
//   kumi.systems et private.coffee   rapides, mais quota serré (429 + Retry-After)
//   overpass-api.de                  refuse tout par 406, y compris /api/status
//   maps.mail.ru                     lent (15 à 20 s) mais il répond vraiment
// À NE PAS AJOUTER : overpass.osm.ch ne contient que la Suisse. Il répond 200 avec
// une liste vide pour la France, ce qui ferait conclure « aucune forêt » au lieu de
// signaler une panne. Tout miroir ajouté ici doit être vérifié sur son CONTENU, pas
// seulement sur son code HTTP.
// La quarantaine plus bas fait qu'un miroir en panne ne coûte son délai d'attente
// qu'une fois, au lieu de le coûter à chaque visiteur.
const OVERPASS_MIRRORS = (process.env.OVERPASS_MIRRORS || [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
].join(',')).split(',').map(x => x.trim()).filter(Boolean);
const OV_MAX_BODY = 16 * 1024;     // une requête Overpass tient largement dedans
const OV_TIMEOUT_MS = 25000;       // par miroir : une requête de 400 km² demande du temps
const OV_TOTAL_MS = 50000;         // budget global : reste sous le proxy_read_timeout de 60 s
                                   // des reverse proxys (nginx, Nginx Proxy Manager)
const OV_MAX_PARALLEL = 4;         // pas plus de 4 requêtes sortantes en même temps
const OV_RATE_MAX = 20;            // par minute et par adresse
let ovBusy = 0;
const ovHits = new Map();

/* --- quarantaine ---------------------------------------------------------
   Un miroir qui vient de refuser (quota) ou de ne pas répondre est écarté
   pendant un moment. Sans cela, un miroir mort consomme tout le budget de
   chaque requête : c'est exactement ce qui faisait échouer le relais, le
   premier de la liste mettant 20 s à ne pas répondre.                      */
const ovCooldown = new Map();      // hôte -> instant avant lequel on ne retente pas
function ovQuarantine(host, ms){ ovCooldown.set(host, Date.now() + ms); }
function ovQuarantined(host){
  const until = ovCooldown.get(host);
  if(!until) return 0;
  if(until <= Date.now()){ ovCooldown.delete(host); return 0; }
  return Math.round((until - Date.now()) / 1000);
}

/* --- cache des réponses ---------------------------------------------------
   L'occupation du sol d'une zone ne change pas d'une minute à l'autre, et le
   simulateur redemande la même zone dès qu'on déplace un nœud. Garder la
   réponse évite de redemander aux miroirs publics — c'est aussi ce qui nous
   faisait atteindre leur quota. Une entrée périmée est conservée : mieux vaut
   des bois d'il y a trois jours que pas de bois du tout.                    */
const crypto = require('crypto');
const OV_FRESH_MS = 24 * 3600 * 1000;        // servie directement
const OV_STALE_MS = 7 * 24 * 3600 * 1000;    // servie en secours si tout échoue
const OV_CACHE_MAX = 60;                     // entrées
const OV_CACHE_BYTES = 48 * 1024 * 1024;     // plafond mémoire
const ovCache = new Map();                   // clé -> {at, text, host}
let ovCacheBytes = 0;

function ovKey(q){ return crypto.createHash('sha1').update(q).digest('hex'); }
function ovCacheGet(key){
  const e = ovCache.get(key);
  if(!e) return null;
  if(Date.now() - e.at > OV_STALE_MS){ ovCache.delete(key); ovCacheBytes -= e.text.length; return null; }
  ovCache.delete(key); ovCache.set(key, e);          // remonte en tête : les plus vieilles sortent d'abord
  return e;
}
function ovCachePut(key, text, host){
  const old = ovCache.get(key);
  if(old){ ovCache.delete(key); ovCacheBytes -= old.text.length; }
  ovCache.set(key, {at: Date.now(), text, host});
  ovCacheBytes += text.length;
  while(ovCache.size > OV_CACHE_MAX || ovCacheBytes > OV_CACHE_BYTES){
    const k = ovCache.keys().next().value;
    if(k === undefined) break;
    ovCacheBytes -= ovCache.get(k).text.length;
    ovCache.delete(k);
  }
}

function ovRateOk(ip){
  const now = Date.now();
  const arr = (ovHits.get(ip) || []).filter(t => now - t < 60000);
  if(arr.length >= OV_RATE_MAX){ ovHits.set(ip, arr); return false; }
  arr.push(now); ovHits.set(ip, arr);
  if(ovHits.size > 500) for(const [k, v] of ovHits) if(!v.length || now - v[v.length-1] > 60000) ovHits.delete(k);
  return true;
}

function readBody(req, limit){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let over = false;
    req.on('data', c => {
      if(over) return;
      size += c.length;
      // on cesse d'accumuler, mais on laisse la connexion vivante le temps de répondre 413
      if(size > limit){ over = true; reject(new Error('trop volumineux')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Envoi de la réponse JSON, compressée si le navigateur l'accepte.
function ovSendJson(req, res, text, host, state){
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Overpass-Mirror', host);
  res.setHeader('X-Overpass-Cache', state);          // hit | stale | miss
  if(/\bgzip\b/.test(req.headers['accept-encoding'] || '') && text.length > 1024){
    const buf = zlib.gzipSync(Buffer.from(text), {level: 6});
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', buf.length);
    res.writeHead(200); return res.end(buf);
  }
  res.writeHead(200); return res.end(text);
}

async function overpassProxy(req, res){
  securityHeaders(res);
  if(!OVERPASS_ON) return send(res, 404, 'Relais Overpass désactivé\n');
  if(req.method !== 'POST') return send(res, 405, 'Méthode non autorisée\n', {'Allow':'POST'});
  if(!ovRateOk(clientIp(req))) return send(res, 429, 'Trop de requêtes, réessayez dans une minute\n');

  let body;
  try { body = await readBody(req, OV_MAX_BODY); }
  catch(e){ res.setHeader('Connection','close'); return send(res, 413, 'Requête trop volumineuse\n'); }
  const q = new URLSearchParams(body).get('data') || '';
  // on ne relaie que des requêtes Overpass de lecture, pas n'importe quoi
  if(!/^\s*\[out:json\]/.test(q)) return send(res, 400, 'Requête Overpass invalide\n');

  // déjà vue récemment : on répond sans déranger personne
  const key = ovKey(q);
  const cached = ovCacheGet(key);
  if(cached && Date.now() - cached.at < OV_FRESH_MS) return ovSendJson(req, res, cached.text, cached.host, 'hit');

  if(ovBusy >= OV_MAX_PARALLEL) return send(res, 503, 'Relais occupé, réessayez\n');
  ovBusy++;
  const errs = [];
  const deadline = Date.now() + OV_TOTAL_MS;
  try {
    for(const url of OVERPASS_MIRRORS){
      const host = (() => { try { return new URL(url).host; } catch(e){ return url; } })();
      const left = deadline - Date.now();
      if(left < 2000){ errs.push('temps imparti dépassé'); break; }
      const rest = ovQuarantined(host);
      if(rest){ errs.push(`${host} : écarté encore ${rest} s`); continue; }
      try {
        const r = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: {'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json'},
          signal: AbortSignal.timeout(Math.min(OV_TIMEOUT_MS, left))
        });
        if(!r.ok){
          if(r.status === 429){
            const ra = Number(r.headers.get('retry-after'));
            ovQuarantine(host, Math.min(300, Math.max(30, Number.isFinite(ra) && ra > 0 ? ra : 60)) * 1000);
          } else {
            ovQuarantine(host, 120000);              // 406, 502, 504… : on laisse reposer 2 min
          }
          errs.push(`${host} : erreur ${r.status}`);
          continue;
        }
        const text = await r.text();
        if(!text.trimStart().startsWith('{')){ ovQuarantine(host, 120000); errs.push(`${host} : réponse inattendue`); continue; }
        // trace : une instance qui ne porte qu'un extrait régional répond 200 avec une
        // liste vide. C'est indiscernable d'une zone réellement sans bois, mais si cela
        // se répète pour toutes les zones, le journal le montre.
        if(/"elements"\s*:\s*\[\s*\]/.test(text)) writeLog(`${new Date().toISOString()} OVERPASS ${host} : réponse vide pour cette zone`);
        ovCachePut(key, text, host);
        return ovSendJson(req, res, text, host, 'miss');
      } catch(e){
        const mute = e.name === 'TimeoutError';
        ovQuarantine(host, mute ? 180000 : 120000);  // un miroir muet coûte cher : 3 min de repos
        errs.push(`${host} : ${mute ? 'pas de réponse' : e.message}`);
      }
    }
    // tout a échoué : une réponse d'il y a quelques jours vaut mieux que rien
    if(cached) return ovSendJson(req, res, cached.text, cached.host, 'stale');
    send(res, 502, 'Serveurs OpenStreetMap indisponibles (' + errs.join(' ; ') + ')\n');
  } finally { ovBusy--; }
}

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
  const ip = clientIp(req);
  // la sonde de santé interroge /healthz toutes les 30 s : inutile de la journaliser
  if(req.url !== '/healthz') res.on('finish', () => logRequest(req, res, ip, Date.now() - t0));

  if(req.url.split('?')[0] === '/api/overpass') return void overpassProxy(req, res);

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
  console.log(`Journal : ${QUIET ? 'console silencieuse' : 'console'}${ACCESS_LOG ? ' + ' + ACCESS_LOG : ''} · adresses ${TRUST_PROXY ? `lues dans X-Forwarded-For (${TRUST_PROXY} proxy de confiance)` : 'directes — derrière un proxy, définir TRUST_PROXY=1'}`);
});
for(const sig of ['SIGINT','SIGTERM']) process.on(sig, () => { console.log('\nArrêt du serveur.'); if(logStream) logStream.end(); server.close(() => process.exit(0)); });
