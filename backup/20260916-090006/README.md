# MeshLab RF — simulateur de réseaux maillés LoRa

Simulateur Meshtastic / MeshCore avec relief réel, végétation, bilan de liaison et journal
détaillé des réceptions. Tout tourne dans le navigateur : le serveur ne fait que distribuer
les fichiers.

## Lancer en local

```bash
node server.js          # http://localhost:8080
```

`npm start` fait la même chose. Aucune dépendance à installer : Node 18 ou plus suffit.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | port d'écoute |
| `HOST` | `0.0.0.0` | interface d'écoute |
| `QUIET` | – | `1` supprime le journal des requêtes |
| `CSP` | – | `off` retire l'en-tête Content-Security-Policy |

## Héberger

### Avec Docker

```bash
docker compose up -d --build
```

L'application répond alors sur le port 8080. `/healthz` renvoie `ok` pour les sondes de
supervision.

### Avec Node et systemd

```ini
[Unit]
Description=MeshLab RF
After=network.target

[Service]
WorkingDirectory=/opt/meshlab-rf
ExecStart=/usr/bin/node server.js
Environment=PORT=8080 QUIET=1
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

### Derrière nginx (HTTPS)

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### Sur un hébergement statique

Le simulateur n'a besoin d'aucun serveur applicatif. Déposer `index.html`, `geo.js`,
`engine.js`, `app.js` (et `cr.html` pour le compte rendu) sur GitHub Pages, Netlify,
Cloudflare Pages ou un simple dossier Apache fonctionne aussi. Dans ce cas, pense à
reproduire les en-têtes de cache : `no-cache` sur les `.html` et `.js`, sinon une mise à
jour peut mettre longtemps à arriver chez les visiteurs.

## HTTPS obligatoire en ligne

Le navigateur télécharge le relief et les cartes depuis des services externes, tous en
HTTPS. Si la page est servie en HTTP simple, certains navigateurs bloquent ces appels.
Un certificat (Let's Encrypt par exemple) est donc nécessaire.

## Services externes utilisés par le navigateur

Ils sont déclarés dans l'en-tête `Content-Security-Policy` du serveur. Toute nouvelle
source de données doit y être ajoutée, sinon le navigateur la bloque.

| Service | Usage |
|---|---|
| `s3.amazonaws.com` (AWS Terrain Tiles) | relief SRTM |
| `overpass-api.de`, `maps.mail.ru`, `overpass.private.coffee` | forêts et bâti (OpenStreetMap) |
| `data.geopf.fr` (IGN) | profil altimétrique haute précision, France |
| `server.arcgisonline.com`, `tile.openstreetmap.org`, `tile.opentopomap.org` | fonds de carte |
| `cdnjs.cloudflare.com` | Leaflet et Chart.js |

Les serveurs Overpass sont gratuits et souvent saturés. Pour un site public fréquenté,
mieux vaut héberger sa propre instance Overpass, ou prévoir que la végétation ne se charge
pas toujours : l'application le signale et réessaie seule.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | page et styles |
| `geo.js` | relief, végétation, propagation radio |
| `engine.js` | moteur de simulation, protocoles |
| `app.js` | interface, carte, journal, dashboard |
| `server.js` | serveur web statique |
| `cr.html` | compte rendu technique du projet |
| `original/` | version d'origine, non servie |
