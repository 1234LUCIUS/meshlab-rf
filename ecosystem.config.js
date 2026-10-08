/* =========================================================================
   MeshLab RF — configuration PM2
   ---------------------------------------------------------------------
   Démarrer :   pm2 start ecosystem.config.js
   Recharger après modification de ce fichier :
                pm2 restart meshlab-rf --update-env
   Au démarrage de la machine :
                pm2 save && pm2 startup     (puis coller la commande affichée)

   HOST limite l'écoute à la seule interface indiquée. En production,
   mettre l'adresse Tailscale de la machine (tailscale ip -4) pour que le
   service ne soit joignable que par le reverse proxy, jamais depuis
   Internet. Laisser 0.0.0.0 uniquement en local.
   ========================================================================= */
module.exports = {
  apps: [{
    name: 'meshlab-rf',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,               // serveur de fichiers : un seul processus suffit
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,        // laisse le temps à tailscaled de monter l'interface
    max_restarts: 50,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: 8765,
      HOST: '100.66.20.117',          // production : remplacer par l'adresse Tailscale 100.x.y.z
      TRUST_PROXY: '1',         // un seul reverse proxy devant (Nginx Proxy Manager)
      // ACCESS_LOG: '/var/log/meshlab/access.log',   // sinon le journal reste dans pm2 logs
      TZ: 'Europe/Paris'
    },
    time: false,                // le serveur horodate déjà chaque ligne
    out_file: undefined,        // journaux par défaut dans ~/.pm2/logs/
    error_file: undefined
  }]
};
