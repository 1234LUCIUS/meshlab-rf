# MeshLab RF — simulateur de réseaux maillés LoRa

Simulateur Meshtastic / MeshCore avec relief réel, végétation, bilan de liaison et journal
détaillé des réceptions. Tout tourne dans le navigateur : le serveur ne fait que distribuer
les fichiers.

## Lancer en local

```bash
node server.js          # http://localhost:8765
```

`npm start` fait la même chose. Aucune dépendance à installer : Node 18 ou plus suffit.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8765` | port d'écoute |
| `HOST` | `0.0.0.0` | interface d'écoute |
| `QUIET` | – | `1` supprime l'affichage du journal dans la console |
| `ACCESS_LOG` | – | chemin d'un fichier où écrire le journal des accès |
| `TRUST_PROXY` | – | nombre de reverse proxys devant le serveur ; `1` derrière nginx |
| `CSP` | – | `off` retire l'en-tête Content-Security-Policy |
| `OVERPASS` | – | `off` désactive le relais OpenStreetMap `/api/overpass` |
| `OVERPASS_MIRRORS` | 4 miroirs publics | liste de miroirs Overpass séparés par des virgules |

### Végétation et bâti : l'IGN d'abord, Overpass en secours

En France et dans les DOM, forêts et bâtiments viennent de la **BD TOPO de l'IGN**, servie en
images WMS par la Géoplateforme : pas de quota, un en-tête CORS correct, quelques centaines
de millisecondes par image, et des données plus complètes que celles d'OpenStreetMap. Deux
couches sont demandées, `BDTOPO-GEOPO-VEGETATION_WLD_WGS84G` et `BDTOPO-GEOPO-BATI_WLD_WGS84G`,
puis converties en grille de cellules. Hors de cette couverture, ou si le service IGN refuse,
l'application repasse d'elle-même à OpenStreetMap.

Deux particularités de ces couches, mesurées et compensées dans le code :

- elles cessent d'être dessinées au-delà d'une certaine grossièreté (végétation ~7 m/pixel,
  bâti ~4,8 m/pixel) et renvoient alors une image vide. Les images sont donc demandées plus
  fines que la grille de travail, découpées en morceaux si besoin ;
- la BD TOPO donne des **bâtiments**, là où le modèle de clutter raisonne en **zone bâtie**.
  Le bâti est donc élargi d'environ 25 m, ce qui retrouve l'enveloppe des villages. Contrôle
  sur la vallée de la Seine : 14,4 % de bâti contre 15,6 % pour les zones `landuse=residential`
  d'OpenStreetMap, et 86 % des cellules classées pareil par les deux sources.

### Le relais OpenStreetMap

Le serveur expose `POST /api/overpass`, qui transmet la requête aux miroirs Overpass publics
et renvoie la première réponse valable. Les serveurs Overpass sont irréguliers et, en panne,
renvoient parfois une erreur dépourvue d'en-tête CORS que le navigateur refuse de lire : de
serveur à serveur, ce problème disparaît. Quand la page est servie par `server.js`, le
navigateur n'appelle **que** le relais ; les miroirs publics ne sont contactés directement que
sur un hébergement statique, où le relais n'existe pas.

Le relais n'accepte que des requêtes Overpass de lecture (`[out:json]…`), plafonnées à 16 ko,
20 par minute et par adresse, 4 requêtes sortantes au plus à la fois. Il ajoute deux choses
qui changent tout en pratique :

- **un cache** (24 h, repli sur une réponse de moins de 7 jours si tous les miroirs tombent).
  L'occupation du sol d'une zone ne change pas d'une minute à l'autre, et le simulateur
  redemande la même zone dès qu'on déplace un nœud : sans cache, c'est ce qui épuisait le
  quota des serveurs publics ;
- **une quarantaine** : un miroir qui répond 429, 406 ou rien du tout est écarté une à trois
  minutes. Sans cela, un miroir mort consommait le délai d'attente de chaque visiteur — c'est
  ce qui faisait échouer le relais, le premier de la liste mettant 20 s à ne pas répondre.

Les miroirs de la liste ont été vérifiés sur leur **contenu**, pas seulement sur leur code
HTTP : `overpass.osm.ch`, par exemple, ne porte qu'un extrait suisse et répond 200 avec une
liste vide pour la France — ce qui ferait conclure « aucune forêt » au lieu de signaler une
panne. Tout ajout à `OVERPASS_MIRRORS` doit être contrôlé de la même façon.

## Héberger

### Avec Docker

```bash
docker compose up -d --build
```

L'application répond alors sur le port 8765. `/healthz` renvoie `ok` pour les sondes de
supervision.

### Avec Node et systemd

```ini
[Unit]
Description=MeshLab RF
# tailscaled doit être démarré avant, sinon l'adresse 100.x n'existe pas encore
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
WorkingDirectory=/opt/meshlab-rf
ExecStart=/usr/bin/node server.js
Environment=PORT=8765 TRUST_PROXY=1 ACCESS_LOG=/var/log/meshlab/access.log
Environment=HOST=100.x.y.z
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

`HOST=100.x.y.z` limite l'écoute à l'interface Tailscale. `RestartSec=5` couvre le cas où
le service démarre avant que Tailscale ait monté l'interface : il réessaie au lieu
d'abandonner sur `EADDRNOTAVAIL`.

### Avec PM2

Un fichier `ecosystem.config.js` est fourni : il contient le port, l'interface d'écoute et
`TRUST_PROXY`, ce qui évite d'avoir à les repasser à chaque commande.

```bash
pm2 start ecosystem.config.js
pm2 save                       # réécrit la liste des services à relancer
pm2 startup                    # affiche la commande à coller pour le démarrage automatique
```

Avant le premier démarrage en production, remplacer `HOST: '0.0.0.0'` par l'adresse Tailscale
de la machine (`tailscale ip -4`). Après toute modification du fichier :

```bash
pm2 restart meshlab-rf --update-env
```

L'option `--update-env` est indispensable : sans elle, PM2 conserve les variables mémorisées
au premier démarrage.

Journal : `pm2 logs meshlab-rf` affiche les lignes d'accès en direct, `pm2 logs meshlab-rf
--lines 200` les dernières. Les fichiers se trouvent dans `~/.pm2/logs/`. Pour éviter qu'ils
grossissent sans fin :

```bash
pm2 install pm2-logrotate
```

`ACCESS_LOG` reste utile si tu préfères un fichier dédié, séparé des messages de PM2.

### Derrière nginx (HTTPS)

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Avec cette configuration, lancer le serveur avec `TRUST_PROXY=1` : sans cela, toutes les
requêtes seraient journalisées comme venant de `127.0.0.1`, l'adresse de nginx.

### Avec Nginx Proxy Manager, sur une autre machine

Nginx Proxy Manager transmet déjà `X-Forwarded-For` : il n'y a rien à ajouter dans l'onglet
« Advanced » du proxy host. `TRUST_PROXY=1` se met du côté de MeshLab RF, pas de NPM.

Si le proxy joint le serveur par une autre machine (Tailscale, VPN, réseau local), **limiter
l'écoute à cette interface** :

```bash
HOST=100.x.y.z PORT=8765 TRUST_PROXY=1 node server.js
```

ou, en Docker, publier le port sur cette seule adresse :

```yaml
ports:
  - "100.x.y.z:8765:8765"
```

Sans cela, le port reste joignable directement, et n'importe qui pourrait alors forger
l'en-tête `X-Forwarded-For` pour fausser le journal ou contourner la limite du relais
Overpass — puisque `TRUST_PROXY=1` demande justement de faire confiance à cet en-tête.

### Proxy sur une machine, application sur une autre, reliées par Tailscale

C'est le montage utilisé ici : le nom de domaine pointe vers la machine NPM, qui joint
l'application par son adresse Tailscale. Le trafic entre les deux passe dans le tunnel
WireGuard, donc HTTP en clair y est sans risque.

Dans NPM, créer le proxy host avec :

| Champ | Valeur |
|---|---|
| Domain Names | `mesh.exemple.fr` |
| Scheme | `http` |
| Forward Hostname / IP | l'adresse Tailscale de la machine applicative, `100.x.y.z` |
| Forward Port | `8765` |
| SSL | certificat Let's Encrypt, *Force SSL* activé |

Côté application, `TRUST_PROXY=1` et une écoute limitée à l'interface Tailscale.

**En Docker, publier le port sur cette seule adresse** :

```yaml
ports:
  - "100.x.y.z:8765:8765"
```

Ce n'est pas une précaution facultative : Docker écrit ses propres règles iptables **en amont
d'ufw**, si bien qu'un `ufw deny 8765` ne protège pas un port publié sur `0.0.0.0`. Préciser
l'adresse dans la section `ports` est le seul moyen fiable de ne pas ouvrir le service sur
Internet.

Hors Docker, `HOST=100.x.y.z` suffit ; on peut ajouter une ceinture au pare-feu :

```bash
ufw allow in on tailscale0 to any port 8765 proto tcp
ufw deny 8765
```

Vérifier ensuite, depuis une machine extérieure au tailnet, que le port est bien fermé :

```bash
curl -m 5 http://<ip-publique-du-serveur>:8765/healthz    # doit échouer
```

Pour aller plus loin, une ACL Tailscale peut n'autoriser que la machine NPM à joindre le port
8765 de la machine applicative, au lieu de tout le tailnet.

### Où exposer le port, selon le montage

`TRUST_PROXY=1` vaut pour tous ces cas : il n'y a toujours qu'un seul proxy devant le
serveur. Ce qui change, c'est **par où le proxy doit joindre le serveur**, et donc ce qu'il
faut laisser ouvert.

| Montage | À régler | Adresse dans le proxy host |
|---|---|---|
| NPM en Docker, MeshLab RF en Docker, **même machine** | réseau Docker commun, **aucun port publié** | `http://meshlab-rf:8765` |
| NPM en Docker, MeshLab RF hors Docker, même machine | `HOST=172.17.0.1`, et `ufw deny 8765` depuis l'extérieur | `http://172.17.0.1:8765` |
| NPM et MeshLab RF sur des **machines différentes** (le cas ici) | joindre par Tailscale, `HOST=<ip du tunnel>` ; en Docker, publier sur cette seule adresse | `http://100.x.y.z:8765` |

Le premier montage est le plus sûr : rien n'écoute sur une interface publique.

```yaml
# docker-compose.yml, quand NPM tourne sur la même machine
services:
  meshlab-rf:
    build: .
    container_name: meshlab-rf
    restart: unless-stopped
    # aucune section "ports" : seul le réseau de NPM peut joindre le conteneur
    environment:
      TRUST_PROXY: "1"
      TZ: Europe/Paris
    networks: [npm]

networks:
  npm:
    external: true
    name: <nom-du-reseau-docker-de-npm>
```

`docker network ls` donne le nom du réseau de NPM (souvent `npm_default` ou
`nginx-proxy-manager_default`).

**À ne pas faire sur un serveur public** : publier `8765` sur `0.0.0.0` alors que le proxy
est ailleurs. Le site serait alors joignable en HTTP simple sur `http://<ip>:8765`, hors
HTTPS, et l'en-tête `X-Forwarded-For` deviendrait falsifiable. Si c'est inévitable, restreindre
au pare-feu à la seule adresse du proxy :

```bash
ufw allow from <ip-du-proxy> to any port 8765 proto tcp
ufw deny 8765
```

## Journal des accès

Le serveur écrit une ligne par requête, et une ligne `VISITE` la première fois qu'une adresse
apparaît — ou après 30 minutes sans activité de sa part :

```
2026-09-16T08:12:03.100Z VISITE 203.0.113.7 /  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) …"
2026-09-16T08:12:03.123Z 203.0.113.7 GET / -> 200 (4 ms)
2026-09-16T08:12:03.288Z 203.0.113.7 GET /app.js -> 200 (12 ms)
```

Par défaut le journal part dans la console, donc dans `journalctl -u meshlab` avec systemd ou
`docker compose logs` avec Docker. `ACCESS_LOG=/chemin/access.log` l'écrit en plus dans un
fichier, que `QUIET=1` n'affecte pas. Les requêtes vers `/healthz` ne sont pas journalisées,
pour ne pas noyer le journal sous les sondes de santé.

Compter les visiteurs uniques du jour :

```bash
grep VISITE access.log | grep "$(date +%F)" | awk '{print $3}' | sort -u | wc -l
```

Une adresse IP est une donnée personnelle : si le site est public, pense à annoncer cette
journalisation et à purger le fichier au bout d'une durée raisonnable, par exemple avec
`logrotate`.

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
| `data.geopf.fr` (IGN Géoplateforme) | relief RGE ALTI®, végétation et bâti BD TOPO — **sources par défaut en France et dans les DOM** —, chefs-lieux de communes (ADMIN EXPRESS, pour nommer les nœuds) et profil altimétrique 1 m à la demande |
| `s3.amazonaws.com` (AWS Terrain Tiles) | relief SRTM, hors couverture IGN |
| `overpass-api.de`, `maps.mail.ru`, `overpass.kumi.systems`, `overpass.private.coffee` | forêts et bâti OpenStreetMap, hors couverture IGN ou en secours. Contactés par le relais du serveur ; par le navigateur seulement sur un hébergement statique |
| `server.arcgisonline.com`, `tile.openstreetmap.org`, `tile.opentopomap.org` | fonds de carte |
| `cdnjs.cloudflare.com` | Leaflet et Chart.js |

Le relief IGN est servi en tuiles WMTS BIL float32 de 256 ko chacune (environ 210 ko
compressées). Une zone de simulation en demande typiquement 15 à 40, soit 3 à 8 Mo, une
seule fois : le serveur de l'IGN autorise 21 jours de cache navigateur. Au-delà de 40
tuiles — zone de plus d'une cinquantaine de kilomètres — l'application repasse d'elle-même
au SRTM mondial, tout comme hors de France ou en bord de mer.

Les serveurs Overpass sont gratuits et souvent saturés : quotas de quelques requêtes par
minute et par adresse, instances en panne pendant des semaines. C'est la raison d'être de la
bascule vers l'IGN en France — sur un site public fréquenté, la totalité des visiteurs partage
la même adresse sortante, donc le même quota. Hors de France, prévoir que la végétation ne se
charge pas toujours : l'application le signale et réessaie seule, de plus en plus espacé.

## Ce que le navigateur garde

Le serveur ne stocke rien des visiteurs : il n'y a ni compte, ni base de données, ni cookie.
Les réseaux construits par l'utilisateur sont écrits dans le **localStorage de son navigateur**,
sur sa machine, sous trois clés :

| Clé | Contenu |
|---|---|
| `meshlabrf.session.v1` | le réseau affiché, réécrit dès qu'il change, rechargé à l'ouverture |
| `meshlabrf.saves.v1` | les réseaux nommés de la section « Mes réseaux » |
| `meshlabrf.popout.v1` | position et taille de la fenêtre détachée |

Aucune de ces données ne remonte au serveur et aucune ne sert à suivre le visiteur : ce ne
sont pas des cookies, et il n'y a donc pas de bandeau de consentement à prévoir. Un réseau
se transporte d'une machine à l'autre par l'export en fichier `.json`.

Compter environ 0,1 ko par nœud. Un navigateur accorde en général 5 Mo par site ; au-delà,
l'interface affiche « stockage plein » au lieu d'échouer en silence.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | page et styles |
| `geo.js` | relief, végétation, propagation radio |
| `engine.js` | moteur de simulation, protocoles |
| `workspace.js` | sauvegarde locale des réseaux, fenêtre détachée |
| `app.js` | interface, carte, journal, dashboard |
| `server.js` | serveur web statique |
| `cr.html` | compte rendu technique du projet |
| `original/` | version d'origine, non servie |
