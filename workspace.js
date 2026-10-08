/* =========================================================================
   MeshLab RF — Espace de travail
   ---------------------------------------------------------------------
   Deux fonctions indépendantes du moteur de simulation :

   1. SAUVEGARDE LOCALE. Les nœuds placés et les réglages sont écrits dans
      le localStorage du navigateur. Ils reviennent tels quels à la
      prochaine ouverture, sans compte ni serveur, et rien ne quitte la
      machine. Le stockage est propre à un navigateur ET à une machine :
      d'où l'export en fichier .json pour transporter un réseau ailleurs
      ou en garder une copie hors du navigateur.

   2. FENÊTRE DÉTACHÉE. Le panneau du bas (journal et tableau des liaisons)
      est déplacé dans une fenêtre séparée, à poser sur un second écran.
      C'est le même élément du DOM qui est déplacé, pas une copie : le code
      d'affichage et les gestionnaires de clic continuent de fonctionner
      sans rien savoir du déménagement. $ et $all (app.js) cherchent dans
      les deux documents. La position et la taille de la fenêtre sont
      mémorisées, donc elle se rouvre sur le même écran.

   Ce fichier est chargé AVANT app.js ; boot() appelle workspaceBoot() à la
   fin du démarrage.
   ========================================================================= */
'use strict';

const WS_KEY_SESSION = 'meshlabrf.session.v1';   // scène courante, réécrite automatiquement
const WS_KEY_SAVES   = 'meshlabrf.saves.v1';     // enregistrements nommés
const WS_KEY_POPOUT  = 'meshlabrf.popout.v1';    // géométrie de la fenêtre détachée
const WS_SCENE_V     = 1;
const WS_MAX_SAVES   = 40;
const WS_MAX_NODES   = 5000;

const WS = {
  booted:false, restoring:false,
  saves:[], removed:new Set(), stamp:'', lastAuto:null, timer:null,
  storage:'ok', storageMsg:'',                   // ok | full | off
  tabId:'t' + Date.now().toString(36) + Math.random().toString(36).slice(2,7),
  seenAt:null,                                   // savedAt du dernier enregistrement que cet onglet a lu ou écrit
  passive:false,                                 // un autre onglet tient la plume : on n'écrit plus
  win:null, doc:null, wrap:null, holder:null, note:null, poll:null, geomSig:''
};

/* ---------------- stockage du navigateur ---------------- */
// localStorage peut être absent (navigation privée verrouillée), plein, ou refusé
// par un réglage de confidentialité : aucune de ces situations ne doit casser
// l'application, elle doit seulement se voir dans l'interface.
function wsRead(key){
  try{ const raw=localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch(e){ WS.storage='off'; WS.storageMsg=e.message||'indisponible'; return null; }
}
function wsWrite(key, val){
  try{
    localStorage.setItem(key, JSON.stringify(val));
    WS.storage='ok'; WS.storageMsg='';
    return true;
  }catch(e){
    const full = e && (e.name==='QuotaExceededError' || e.name==='NS_ERROR_DOM_QUOTA_REACHED' || e.code===22);
    WS.storage = full ? 'full' : 'off';
    WS.storageMsg = full ? 'espace de stockage plein' : (e.message||'indisponible');
    return false;
  }
}
function wsBytes(){
  try{
    let n=0;
    for(const k of [WS_KEY_SESSION, WS_KEY_SAVES]){ const v=localStorage.getItem(k); if(v) n+=v.length; }
    return n;
  }catch(e){ return 0; }
}

/* ---------------- lecture défensive d'une scène ---------------- */
// Une scène peut venir d'un fichier fourni par l'utilisateur : tout ce qui en sort
// est borné et filtré avant d'atteindre le moteur.
function wsNum(v, lo, hi, dflt){
  if(v===null || v===undefined || v==='') return dflt;   // absent : on garde la valeur par défaut
  const x=Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : dflt;
}
function wsCoord(v, lim){ const x=Number(v); return (Number.isFinite(x) && Math.abs(x)<=lim) ? x : null; }
function wsPick(v, allowed, dflt){ return allowed.indexOf(v)>=0 ? v : dflt; }
function wsStr(v, max, dflt){ return (typeof v==='string' && v.trim()) ? v.trim().slice(0, max) : dflt; }
function wsBool(v, dflt){ return typeof v==='boolean' ? v : dflt; }

const WS_CFG_RANGE = {
  hopLimit:[0,7], mcFloodMax:[1,64], mcTxDelayFactor:[0,4], mcDirectTxDelayFactor:[0,4],
  mcPathFailMax:[1,20], mcLocalAdvertMin:[0,1440], mcFloodAdvertH:[1,240], mcMaxAttempts:[1,5],
  preambleSym:[6,32], noiseFigureDb:[1,15], captureDb:[0,20], fadingSigmaDb:[0,12],
  queueMax:[1,64], maxLinkKm:[1,300], goodMarginDb:[0,40],
  historyBucketMs:[1000,60000], dutyWindowMs:[60000,3600000]
};
const WS_CFG_BOOL = ['mtAckEnabled','retxEnabled','mcRoomServerForward'];
const WS_ROLES = ['client','router','repeater'];

/* ---------------- la scène : ce qui est enregistré ---------------- */
// Uniquement ce que l'utilisateur a construit et réglé. Rien de l'état vivant de la
// simulation (horloge, paquets en vol, statistiques) : il se reconstruit tout seul.
function wsScene(){
  const c = ui.map ? ui.map.getCenter() : null;
  const D = DEFAULT_NODE_PROFILES;
  return {
    app:'meshlab-rf', v:WS_SCENE_V, savedAt:new Date().toISOString(),
    protocol: sim.protocol,
    radio: {freqMHz:sim.radioCfg.freqMHz, sf:sim.radioCfg.sf, bwKHz:sim.radioCfg.bwKHz,
            cr:sim.radioCfg.cr, preset:sim.radioCfg.preset},
    reg: sim.regProfile,
    cfg: Object.assign({}, sim.cfg),
    defaults: {client:Object.assign({},D.client), router:Object.assign({},D.router), repeater:Object.assign({},D.repeater)},
    traffic: {mode:sim.traffic.mode, customMsgPerHour:sim.traffic.customMsgPerHour,
              dmShare:sim.traffic.dmShare, background:sim.traffic.background},
    env: {demMode:sim.demMode, demPrefer:sim.demPrefer, coverEnabled:sim.coverEnabled, coverPrefer:sim.coverPrefer,
          clutter:Object.assign({}, sim.clutterCfg), kFactor:sim.kFactor},
    view: c ? {lat:+c.lat.toFixed(5), lng:+c.lng.toFixed(5), zoom:ui.map.getZoom(), base:ui.baseName||null} : null,
    panel: {bottomTab:ui.bottomTab||'log', pedago:!!ui.pedago, expert:!!ui.expert, autoName:!!ui.autoName},
    // 6 décimales ≈ 11 cm : bien au-delà de ce que la propagation sait distinguer,
    // et deux fois plus léger que les flottants bruts pour 500 nœuds.
    nodes: sim.nodes.map(n=>({
      lat:+n.lat.toFixed(6), lng:+n.lng.toFixed(6), role:n.role,
      h:n.heightM, tx:n.txPowerDbm, g:n.antGainDbi, label:n.label, auto:n.autoLabel, on:n.active
    }))
  };
}

function wsSceneValid(s){ return !!s && typeof s==='object' && Array.isArray(s.nodes); }

// Remplace entièrement la scène courante. Les identifiants de nœuds sont réattribués
// par le moteur ; c'est l'étiquette qui est conservée, pas le numéro interne.
function wsApplyScene(s){
  if(!wsSceneValid(s)) throw new Error('ce fichier ne contient pas de réseau MeshLab RF');
  WS.restoring=true;
  try{
    sim.protocol = wsPick(s.protocol, ['meshtastic','meshcore'], sim.protocol);
    const ps = $('#protoSelect'); if(ps) ps.value=sim.protocol;

    if(s.radio && typeof s.radio==='object'){
      sim.radioCfg.freqMHz = wsNum(s.radio.freqMHz, 100, 3000, sim.radioCfg.freqMHz);
      sim.radioCfg.sf      = wsPick(Math.round(wsNum(s.radio.sf, 7, 12, 11)), [7,8,9,10,11,12], 11);
      sim.radioCfg.bwKHz   = wsPick(wsNum(s.radio.bwKHz, 62.5, 500, 250), [62.5,125,250,500], 250);
      sim.radioCfg.cr      = wsPick(Math.round(wsNum(s.radio.cr, 1, 4, 1)), [1,2,3,4], 1);
      sim.radioCfg.preset  = wsPick(s.radio.preset, Object.keys(MODEM_PRESETS).concat(['custom']), 'custom');
    }
    sim.regProfile = wsPick(s.reg, Object.keys(REG_PROFILES), sim.regProfile);

    if(s.cfg && typeof s.cfg==='object'){
      for(const k in WS_CFG_RANGE) if(k in s.cfg)
        sim.cfg[k] = wsNum(s.cfg[k], WS_CFG_RANGE[k][0], WS_CFG_RANGE[k][1], sim.cfg[k]);
      for(const k of WS_CFG_BOOL) if(k in s.cfg) sim.cfg[k] = wsBool(s.cfg[k], sim.cfg[k]);
    }
    if(s.defaults && typeof s.defaults==='object') for(const r of WS_ROLES){
      const d=s.defaults[r]; if(!d || typeof d!=='object') continue;
      DEFAULT_NODE_PROFILES[r].heightM    = wsNum(d.heightM, 0, 300, DEFAULT_NODE_PROFILES[r].heightM);
      DEFAULT_NODE_PROFILES[r].txPowerDbm = wsNum(d.txPowerDbm, -10, 40, DEFAULT_NODE_PROFILES[r].txPowerDbm);
      DEFAULT_NODE_PROFILES[r].antGainDbi = wsNum(d.antGainDbi, -5, 30, DEFAULT_NODE_PROFILES[r].antGainDbi);
    }
    if(s.traffic && typeof s.traffic==='object'){
      sim.traffic.mode = wsPick(s.traffic.mode, Object.keys(TRAFFIC_PRESETS).concat(['custom']), sim.traffic.mode);
      sim.traffic.customMsgPerHour = wsNum(s.traffic.customMsgPerHour, 0, 3600, sim.traffic.customMsgPerHour);
      sim.traffic.dmShare = wsNum(s.traffic.dmShare, 0, 1, sim.traffic.dmShare);
      sim.traffic.background = wsBool(s.traffic.background, sim.traffic.background);
    }
    if(s.env && typeof s.env==='object'){
      sim.demMode      = wsPick(s.env.demMode, ['real','synthetic','none'], sim.demMode);
      sim.demPrefer    = wsPick(s.env.demPrefer, ['auto','srtm'], sim.demPrefer);
      sim.coverEnabled = wsBool(s.env.coverEnabled, sim.coverEnabled);
      sim.coverPrefer  = wsPick(s.env.coverPrefer, ['auto','osm'], sim.coverPrefer);
      sim.kFactor      = wsNum(s.env.kFactor, 0.5, 3, sim.kFactor);
      const cl = s.env.clutter;
      if(cl && typeof cl==='object'){
        sim.clutterCfg.enabled    = wsBool(cl.enabled, sim.clutterCfg.enabled);
        sim.clutterCfg.treeH      = wsNum(cl.treeH, 0, 50, sim.clutterCfg.treeH);
        sim.clutterCfg.builtH     = wsNum(cl.builtH, 0, 80, sim.clutterCfg.builtH);
        sim.clutterCfg.gammaTree  = wsNum(cl.gammaTree, 0, 1, sim.clutterCfg.gammaTree);
        sim.clutterCfg.exclusionM = wsNum(cl.exclusionM, 0, 1000, sim.clutterCfg.exclusionM);
      }
    }
    if(s.panel && typeof s.panel==='object'){
      ui.bottomTab = wsPick(s.panel.bottomTab, ['log','links'], ui.bottomTab||'log');
      ui.pedago = wsBool(s.panel.pedago, ui.pedago);
      ui.autoName = wsBool(s.panel.autoName, ui.autoName);
      ui.expert = wsBool(s.panel.expert, ui.expert);
      const bp=$('#btnPedago'), be=$('#btnExpert');
      if(bp) bp.classList.toggle('on', ui.pedago);
      if(be) be.classList.toggle('on', ui.expert);
    }

    clearAllNodes();
    let skipped=0;
    for(const r of s.nodes.slice(0, WS_MAX_NODES)){
      const lat=wsCoord(r && r.lat, 85), lng=wsCoord(r && r.lng, 180);
      if(lat===null || lng===null){ skipped++; continue; }
      const role = wsPick(r.role, WS_ROLES, 'client');
      const n = sim.addNode(lat, lng, {
        role,
        heightM:    wsNum(r.h,   0, 300, DEFAULT_NODE_PROFILES[role].heightM),
        txPowerDbm: wsNum(r.tx, -10,  40, DEFAULT_NODE_PROFILES[role].txPowerDbm),
        antGainDbi: wsNum(r.g,   -5,  30, DEFAULT_NODE_PROFILES[role].antGainDbi),
        label:      wsStr(r.label, 40, undefined)
      });
      n.active = wsBool(r.on, true);
      n.autoLabel = wsBool(r.auto, !r.label);
      drawNode(n);
    }

    if(s.view && typeof s.view==='object' && ui.map){
      const lat=wsCoord(s.view.lat, 85), lng=wsCoord(s.view.lng, 180);
      if(lat!==null && lng!==null) ui.map.setView([lat,lng], wsNum(s.view.zoom, 2, 19, 12));
      if(s.view.base && ui.setBaseLayer) ui.setBaseLayer(s.view.base);
    }

    sim.reset(); sim.radioChanged(); sim.envChanged();
    renderLeftPanel(); renderTransport(); renderMapLegend(); renderMapOverlay();
    renderRightPanel(); refreshAllMarkers(); renderLogFilters(); renderLogList(true);
    drawCoverOverlay(); updateDemStatus(); updateCoverStatus();
    afterTopologyChange();
    return {count:sim.nodes.length, skipped};
  } finally {
    WS.restoring=false;
    WS.stamp=wsStamp();          // ce qui vient d'être chargé n'est pas une modification à réenregistrer
  }
}

/* ---------------- empreinte : n'écrire que ce qui a changé ---------------- */
// Hachage FNV-1a de ce qui compose la scène. Bien moins coûteux que de sérialiser
// la scène entière toutes les deux secondes pour la comparer à la précédente.
function wsStamp(){
  let h=2166136261;
  const mix = v=>{ h=(h ^ (v|0))>>>0; h=Math.imul(h, 16777619)>>>0; };
  const mixStr = s=>{ s=String(s); for(let i=0;i<s.length;i++) mix(s.charCodeAt(i)); };
  mix(sim.nodes.length);
  for(const n of sim.nodes){
    mix(Math.round(n.lat*1e6)); mix(Math.round(n.lng*1e6));
    mix(Math.round(n.heightM*10)); mix(Math.round(n.txPowerDbm*10)); mix(Math.round(n.antGainDbi*10));
    mix(n.active?1:2); mix(n.autoLabel?1:2); mixStr(n.role); mixStr(n.label);
  }
  mixStr(sim.protocol + sim.regProfile + sim.demMode + sim.demPrefer + sim.coverPrefer + (sim.coverEnabled?'c':'-'));
  mixStr(JSON.stringify(sim.radioCfg) + JSON.stringify(sim.cfg) + JSON.stringify(sim.clutterCfg));
  mixStr(sim.traffic.mode + sim.traffic.customMsgPerHour + (sim.traffic.background?'b':'-'));
  mixStr(JSON.stringify(DEFAULT_NODE_PROFILES) + sim.kFactor);
  return String(h);
}

/* ---------------- enregistrement automatique ---------------- */
/* ---------------- plusieurs onglets ouverts ----------------
   Le stockage local est partagé par tous les onglets d'un même site : deux
   onglets de MeshLab RF écriraient dans la même case et le dernier effacerait
   le réseau de l'autre, sans rien dire. Règle retenue : un onglet qui découvre
   que quelqu'un d'autre a écrit depuis qu'il a regardé arrête d'enregistrer et
   le dit. Reprendre la main est un geste explicite. Ce qui est affiché dans
   l'onglet mis en retrait n'est pas touché : rien n'est perdu, rien ne bouge. */
function wsGoPassive(){
  if(WS.passive) return;
  WS.passive = true;
  renderLeftPanel();
  toast("Un autre onglet de MeshLab RF vient d'enregistrer. Pour ne pas écraser son réseau, cet onglet a cessé d'enregistrer : ce que vous voyez ici reste intact, mais n'est plus sauvegardé. « Reprendre ici », dans « Mes réseaux », rend la main à cet onglet.", true);
}
function wsReclaim(){
  WS.passive = false;
  WS.seenAt = null;                 // on assume : c'est cet onglet qui fait foi désormais
  wsAutoSave(true);
  renderLeftPanel();
  toast("Cet onglet enregistre de nouveau. C'est son réseau qui sera retrouvé à la prochaine ouverture ; l'autre onglet s'arrêtera d'enregistrer à son tour.", true);
}

function wsAutoSave(force){
  if(WS.restoring || !WS.booted || WS.passive) return;
  const st = wsStamp();
  if(!force && st===WS.stamp) return;
  // quelqu'un a-t-il écrit depuis notre dernier passage ?
  if(WS.seenAt !== null){
    const cur = wsRead(WS_KEY_SESSION);
    if(cur && cur.savedAt && cur.savedAt !== WS.seenAt){ wsGoPassive(); return; }
  }
  WS.stamp = st;
  const scene = wsScene();
  scene.by = WS.tabId;
  if(wsWrite(WS_KEY_SESSION, scene)){ WS.lastAuto = new Date(); WS.seenAt = scene.savedAt; }
  wsRefreshStatus();
}
function wsRestoreSession(){
  const s = wsRead(WS_KEY_SESSION);
  if(!wsSceneValid(s) || !s.nodes.length) return false;
  try{
    const r = wsApplyScene(s);
    const t = Date.parse(s.savedAt);
    if(Number.isFinite(t)) WS.lastAuto = new Date(t);
    WS.seenAt = s.savedAt || null;      // point de départ pour détecter l'écriture d'un autre onglet
    toast(`Réseau précédent retrouvé dans ce navigateur : ${r.count} nœud${r.count>1?'s':''} et vos réglages, replacés tels quels. Tout est enregistré ici, sur cette machine. « Mes réseaux », dans le panneau de gauche, permet d'en garder plusieurs et de les exporter en fichier.`);
    return true;
  }catch(e){
    console.warn('Session précédente illisible :', e);
    return false;
  }
}

/* ---------------- enregistrements nommés ---------------- */
function wsNewId(){ return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function wsLoadSaves(){
  const raw = wsRead(WS_KEY_SAVES);
  WS.saves = Array.isArray(raw)
    ? raw.filter(e=>e && typeof e==='object' && typeof e.name==='string' && wsSceneValid(e.scene)).slice(0, WS_MAX_SAVES)
    : [];
}
function wsStoreSaves(){
  // un autre onglet a pu ajouter un réseau nommé entre-temps : on fusionne au lieu d'écraser
  const stored = wsRead(WS_KEY_SAVES);
  if(Array.isArray(stored)){
    const known = new Set(WS.saves.map(e=>e.id));
    const extra = stored.filter(e => e && typeof e==='object' && typeof e.name==='string'
      && wsSceneValid(e.scene) && !known.has(e.id) && !WS.removed.has(e.id));
    if(extra.length) WS.saves = WS.saves.concat(extra).slice(0, WS_MAX_SAVES);
  }
  if(wsWrite(WS_KEY_SAVES, WS.saves)) return true;
  toast(WS.storage==='full'
    ? "Le stockage du navigateur est plein : l'enregistrement n'a pas pu être écrit. Supprimez un réseau de la liste — exportez-le d'abord en fichier .json si vous voulez le garder."
    : "Le navigateur refuse d'écrire dans son stockage local (navigation privée ou réglage de confidentialité). L'export en fichier .json reste possible.", true);
  return false;
}
function wsSaveCurrent(name){
  name = wsStr(name, 60, '') || ('Réseau du ' + new Date().toLocaleDateString('fr-FR'));
  const scene = wsScene();
  const n = scene.nodes.length;
  const existing = WS.saves.find(e=>e.name.toLowerCase()===name.toLowerCase());
  if(existing){
    if(!confirm(`« ${name} » existe déjà (${existing.scene.nodes.length} nœuds). Le remplacer par le réseau actuel (${n} nœud${n>1?'s':''}) ?`)) return false;
    existing.scene=scene; existing.at=scene.savedAt;
  } else {
    WS.saves.unshift({id:wsNewId(), name, at:scene.savedAt, scene});
    if(WS.saves.length>WS_MAX_SAVES) WS.saves.length=WS_MAX_SAVES;
  }
  if(!wsStoreSaves()) return false;
  renderLeftPanel();
  toast(`Réseau « ${esc(name)} » enregistré dans ce navigateur : ${n} nœud${n>1?'s':''}, avec les réglages radio, le trafic, le terrain et la vue de la carte.`);
  return true;
}
function wsLoadSave(id){
  const e = WS.saves.find(x=>x.id===id); if(!e) return;
  const cur = sim.nodes.length;
  if(cur && !confirm(`Charger « ${e.name} » (${e.scene.nodes.length} nœuds) ? Les ${cur} nœud${cur>1?'s':''} actuellement sur la carte seront remplacés.`)) return;
  try{
    const r = wsApplyScene(e.scene);
    wsAutoSave(true);
    toast(`« ${esc(e.name)} » chargé : ${r.count} nœud${r.count>1?'s':''}.${r.skipped?` ${r.skipped} entrée(s) illisibles ignorées.`:''}`);
  }catch(err){ toast('Chargement impossible : '+esc(err.message), true); }
}
function wsDeleteSave(id){
  const e = WS.saves.find(x=>x.id===id); if(!e) return;
  if(!confirm(`Supprimer définitivement « ${e.name} » (${e.scene.nodes.length} nœuds) de ce navigateur ? Le réseau affiché sur la carte n'est pas touché.`)) return;
  WS.saves = WS.saves.filter(x=>x.id!==id);
  WS.removed.add(id);                 // pour que la fusion ci-dessus ne le fasse pas réapparaître
  wsStoreSaves();
  renderLeftPanel();
  toast(`« ${esc(e.name)} » supprimé de la liste.`);
}

/* ---------------- fichier .json ---------------- */
function wsFileName(name){
  const slug = String(name||'reseau').normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase().slice(0,40) || 'reseau';
  const d = new Date(), p = v=>String(v).padStart(2,'0');
  return `meshlab-rf-${slug}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}.json`;
}
function wsExport(id){
  const e = id ? WS.saves.find(x=>x.id===id) : null;
  const scene = e ? e.scene : wsScene();
  const input = $('#wsName');
  const name = e ? e.name : (wsStr(input && input.value, 60, '') || 'reseau');
  const file = wsFileName(name);
  const blob = new Blob([JSON.stringify(Object.assign({name}, scene), null, 1)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download=file;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
  toast(`Fichier ${file} téléchargé : ${scene.nodes.length} nœud${scene.nodes.length>1?'s':''} et leurs réglages. Il se recharge avec « Importer », sur n'importe quelle machine et n'importe quel navigateur.`);
}
function wsImportFile(file){
  if(!file) return;
  if(file.size > 8*1024*1024){ toast("Fichier trop volumineux (plus de 8 Mo) : ce n'est pas un réseau MeshLab RF.", true); return; }
  const fr = new FileReader();
  fr.onerror = ()=>toast('Lecture du fichier impossible.', true);
  fr.onload = ()=>{
    let s;
    try{ s = JSON.parse(String(fr.result)); }
    catch(err){ toast("Ce fichier n'est pas du JSON valide.", true); return; }
    if(!wsSceneValid(s)){ toast("Ce fichier ne contient pas de réseau MeshLab RF (aucune liste de nœuds).", true); return; }
    const cur = sim.nodes.length;
    if(cur && !confirm(`Importer ce réseau (${s.nodes.length} nœuds) ? Les ${cur} nœud${cur>1?'s':''} actuellement sur la carte seront remplacés.`)) return;
    try{
      const r = wsApplyScene(s);
      const name = wsStr(s.name, 60, null) || wsStr(file.name.replace(/\.json$/i,''), 60, 'Réseau importé');
      WS.saves.unshift({id:wsNewId(), name, at:new Date().toISOString(), scene:wsScene()});
      if(WS.saves.length>WS_MAX_SAVES) WS.saves.length=WS_MAX_SAVES;
      wsStoreSaves();
      wsAutoSave(true);
      renderLeftPanel();
      toast(`« ${esc(name)} » importé : ${r.count} nœud${r.count>1?'s':''}${r.skipped?`, ${r.skipped} entrée(s) illisibles ignorées`:''}. Il est aussi ajouté à la liste de ce navigateur.`);
    }catch(err){ toast('Import impossible : '+esc(err.message), true); }
  };
  fr.readAsText(file);
}

/* ---------------- section « Mes réseaux » du panneau de gauche ---------------- */
function wsAgo(iso){
  const t = Date.parse(iso);
  if(!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now()-t)/1000);
  if(s < 90) return "à l'instant";
  if(s < 3600) return `il y a ${Math.round(s/60)} min`;
  if(s < 86400) return `il y a ${Math.round(s/3600)} h`;
  const d = new Date(t);
  return d.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'})
       + ' à ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
}
function wsStatusText(){
  if(WS.passive)
    return `⏸ Un autre onglet de MeshLab RF enregistre à votre place. Rien n'est écrit depuis celui-ci, pour ne pas écraser son réseau.`;
  if(WS.storage==='off')
    return `⚠ Ce navigateur n'autorise pas le stockage local (${esc(WS.storageMsg||'indisponible')}). Rien n'est conservé à la fermeture : utilisez l'export en fichier.`;
  if(WS.storage==='full')
    return `⚠ Stockage du navigateur plein. Supprimez un réseau de la liste pour pouvoir enregistrer de nouveau.`;
  const kb = Math.round(wsBytes()/1024);
  return `✓ Enregistré automatiquement ${WS.lastAuto ? wsAgo(WS.lastAuto.toISOString()) : 'au premier changement'} · ${WS.saves.length} réseau${WS.saves.length>1?'x':''} nommé${WS.saves.length>1?'s':''} · ${kb} Ko utilisés`;
}
function wsRefreshStatus(){
  const el = $('#wsStatus');
  if(el) el.innerHTML = wsStatusText();
}
function wsSection(){
  const rows = WS.saves.length ? WS.saves.map(e=>`
    <div class="ws-row" data-ws-load="${e.id}" title="Cliquer pour charger « ${esc(e.name)} » à la place du réseau affiché">
      <div class="ws-main"><b>${esc(e.name)}</b><span>${e.scene.nodes.length} nœud${e.scene.nodes.length>1?'s':''} · ${esc(wsAgo(e.at))}</span></div>
      <div class="ws-act" data-ws-export="${e.id}" title="Télécharger ce réseau en fichier .json">⬇</div>
      <div class="ws-act danger" data-ws-del="${e.id}" title="Supprimer cet enregistrement">🗑</div>
    </div>`).join('')
    : `<div class="ws-empty">Aucun réseau enregistré pour l'instant. Placez vos nœuds, donnez un nom, puis « Enregistrer ».</div>`;

  return section('saves','Mes réseaux', `
    <div class="hint">Vos nœuds et vos réglages sont gardés <b style="color:var(--text-0)">dans ce navigateur, sur cette machine</b> : ils reviennent seuls à la prochaine ouverture. Rien n'est envoyé au serveur. Un enregistrement nommé garde une copie que vous pouvez recharger à tout moment.</div>
    <div class="field-row" style="margin-top:8px">
      <input type="text" id="wsName" class="ws-input" maxlength="60" placeholder="Nom du réseau (ex. Vallée de l'Eure)">
      <div class="mbtn" id="wsSave" style="flex:none;min-width:0" title="Enregistrer le réseau affiché sous ce nom">💾</div>
    </div>
    <div class="ws-list">${rows}</div>
    <div class="btnrow">
      <div class="mbtn" id="wsExport" title="Télécharger le réseau affiché en fichier .json">⬇ Exporter</div>
      <div class="mbtn" id="wsImport" title="Recharger un fichier .json exporté depuis ce simulateur">⬆ Importer</div>
    </div>
    <input type="file" id="wsFile" accept="application/json,.json" style="display:none">
    <div class="statusline" id="wsStatus">${wsStatusText()}</div>
    ${WS.passive?`<div class="btnrow"><div class="mbtn" id="wsReclaim" title="Cet onglet redevient celui dont le réseau est enregistré">⏵ Reprendre l'enregistrement ici</div></div>`:''}
    <div class="hint">Vider les données du site dans le navigateur efface aussi ces enregistrements : exportez en fichier ce que vous tenez à garder, c'est aussi le seul moyen de passer un réseau d'une machine à l'autre.</div>
  `);
}
function wsWireSection(){
  const nameInput = $('#wsName');
  if(nameInput) nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); wsSaveCurrent(nameInput.value); } });
  const btnSave = $('#wsSave');
  if(btnSave) btnSave.addEventListener('click', ()=>wsSaveCurrent(nameInput ? nameInput.value : ''));
  const btnReclaim = $('#wsReclaim');
  if(btnReclaim) btnReclaim.addEventListener('click', wsReclaim);
  const btnExport = $('#wsExport');
  if(btnExport) btnExport.addEventListener('click', ()=>wsExport(null));
  const file = $('#wsFile'), btnImport = $('#wsImport');
  if(btnImport && file){
    btnImport.addEventListener('click', ()=>file.click());
    file.addEventListener('change', ()=>{ wsImportFile(file.files && file.files[0]); file.value=''; });
  }
  $all('[data-ws-load]').forEach(r=>r.addEventListener('click', e=>{
    const ex = e.target.closest('[data-ws-export]'), del = e.target.closest('[data-ws-del]');
    if(ex) return wsExport(ex.dataset.wsExport);
    if(del) return wsDeleteSave(del.dataset.wsDel);
    wsLoadSave(r.dataset.wsLoad);
  }));
}

/* ---------------- fenêtre détachée ---------------- */
// Feuille de style propre à la fenêtre : la feuille de l'application y est recopiée
// telle quelle, on ne redéfinit ici que la mise en page et une taille de texte
// plus confortable, puisque l'espace n'est plus compté.
const WS_POP_CSS = `
html,body{height:100%;margin:0;overflow:hidden;background:var(--bg-1);color:var(--text-0);font-family:var(--sans);}
body{display:flex;flex-direction:column;}
.logwrap{flex:1;min-height:0;border:0;}
.log-filters{padding:9px 12px;}
.log-list{font-size:12px;}
.log-row{grid-template-columns:104px 78px 1fr;padding:4px 14px;}
.log-tag{font-size:10px;}
.lt-row{font-size:12px;padding:5px 14px;}
.lt-head{font-size:10.5px;}
.lt-sum{font-size:12.5px;padding:8px 14px 9px;}
.rxc{font-size:11.3px;}
.ws-pop-note{padding:6px 14px;font-size:11px;color:var(--text-2);border-top:1px solid var(--line-soft);background:var(--bg-0);}
`;

function wsPopoutOpen(){
  if(WS.win && !WS.win.closed){ try{ WS.win.focus(); }catch(e){} return; }
  const wrap = WS.wrap || document.querySelector('.logwrap');
  if(!wrap) return;
  WS.wrap = wrap;

  const g = wsRead(WS_KEY_POPOUT) || {};
  const w = Math.round(wsNum(g.w, 420, 4000, 1150)), h = Math.round(wsNum(g.h, 240, 3000, 560));
  const feats = ['popup=yes','menubar=no','toolbar=no','location=no','status=no','resizable=yes','scrollbars=yes',
                 'width='+w, 'height='+h];
  if(Number.isFinite(g.x) && Number.isFinite(g.y)){ feats.push('left='+Math.round(g.x), 'top='+Math.round(g.y)); }
  const pop = window.open('', 'meshlabrf-tableau', feats.join(','));
  if(!pop){
    toast("Le navigateur a bloqué la fenêtre détachée. Autorisez les fenêtres surgissantes pour ce site (icône à droite de la barre d'adresse), puis réessayez.", true);
    return;
  }

  const d = pop.document;
  d.open();
  d.write('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>MeshLab RF — journal et liaisons</title></head><body></body></html>');
  d.close();
  // la feuille de style de l'application est recopiée : mêmes couleurs, mêmes pastilles
  $all('style', document).forEach(s=>{ const c=d.createElement('style'); c.textContent=s.textContent; d.head.appendChild(c); });
  const extra = d.createElement('style'); extra.textContent = WS_POP_CSS; d.head.appendChild(extra);

  // le panneau lui-même est DÉPLACÉ, pas copié : les gestionnaires de clic le suivent
  d.body.appendChild(wrap);
  const note = d.createElement('div');
  note.className='ws-pop-note';
  d.body.appendChild(note);
  WS.note = note;
  wsNoteUpdate();

  // à la place laissée libre, un rappel avec le bouton de retour
  const holder = document.createElement('div');
  holder.className='ws-holder';
  holder.innerHTML = `<div><b>Journal et liaisons détachés</b><span>dans une fenêtre séparée — à poser sur votre second écran</span></div><div class="mbtn" id="wsReattach" style="flex:none">⧉ Réintégrer</div>`;
  document.querySelector('.bottom').appendChild(holder);
  holder.querySelector('#wsReattach').addEventListener('click', wsPopoutClose);
  WS.holder = holder;

  WS.win = pop; WS.doc = d;
  try{ pop.moveTo(Math.round(g.x), Math.round(g.y)); pop.resizeTo(w, h); }catch(e){}
  pop.addEventListener('beforeunload', wsPopoutClose);   // fermeture par l'utilisateur : on récupère le panneau
  pop.addEventListener('pagehide', wsPopoutClose);
  clearInterval(WS.poll);
  WS.poll = setInterval(()=>{ if(!WS.win || WS.win.closed) wsPopoutClose(); else wsRememberGeom(); }, 1000);

  renderLogFilters(); renderLogList(true);
  try{ pop.focus(); }catch(e){}
  wsWrite(WS_KEY_POPOUT, Object.assign({}, g, {open:true}));
  toast("Journal et liaisons ouverts dans une fenêtre séparée : faites-la glisser sur votre second écran, sa position sera retenue pour les prochaines fois. Le tableau reste vivant, il continue de suivre la simulation.");
}

// Quand l'onglet principal passe en arrière-plan, le navigateur suspend
// requestAnimationFrame : la simulation s'arrête, donc ce tableau aussi. Mieux vaut
// l'écrire que laisser croire à un blocage.
function wsNoteUpdate(){
  if(!WS.note) return;
  WS.note.textContent = document.visibilityState==='hidden'
    ? "⏸ L'onglet principal de MeshLab RF est en arrière-plan : le navigateur y suspend la simulation, ce tableau reprendra dès que vous y reviendrez."
    : "Fenêtre détachée de MeshLab RF. La fermer, ou « Réintégrer », remet le panneau en bas de la page principale.";
}

function wsPopoutClose(){
  const pop = WS.win;
  if(!pop && !WS.holder) return;
  clearInterval(WS.poll); WS.poll=null;
  if(pop && !pop.closed) wsRememberGeom();
  WS.win=null; WS.doc=null;

  // récupérer le panneau AVANT que la fenêtre ne disparaisse
  const bottom = document.querySelector('.bottom');
  if(WS.wrap && bottom) bottom.appendChild(WS.wrap);
  if(WS.holder){ WS.holder.remove(); WS.holder=null; }
  WS.note=null;

  if(pop && !pop.closed){ try{ pop.close(); }catch(e){} }
  const g = wsRead(WS_KEY_POPOUT) || {};
  g.open = false; wsWrite(WS_KEY_POPOUT, g);
  renderLogFilters(); renderLogList(true);
}

function wsRememberGeom(){
  const p = WS.win;
  if(!p || p.closed) return;
  let g;
  try{ g = {x:p.screenX, y:p.screenY, w:p.outerWidth, h:p.outerHeight, open:true}; }catch(e){ return; }
  if(!Number.isFinite(g.w) || g.w<200) return;
  const sig = [g.x,g.y,g.w,g.h].join(',');
  if(sig===WS.geomSig) return;
  WS.geomSig = sig;
  wsWrite(WS_KEY_POPOUT, g);
}

function wsPopoutToggle(){ if(WS.win && !WS.win.closed) wsPopoutClose(); else wsPopoutOpen(); }
function wsPoppedOut(){ return !!(WS.win && !WS.win.closed); }

/* ---------------- démarrage ---------------- */
function workspaceBoot(){
  if(WS.booted) return;
  WS.booted = true;
  WS.wrap = document.querySelector('.logwrap');
  wsLoadSaves();
  wsRestoreSession();
  WS.stamp = wsStamp();
  renderLeftPanel();

  // toutes les 2 s : on ne réécrit que si l'empreinte de la scène a changé,
  // donc rien pendant que la simulation tourne sans que l'utilisateur touche à rien
  clearInterval(WS.timer);
  WS.timer = setInterval(()=>wsAutoSave(false), 2000);

  // dernier filet : un onglet fermé brutalement ne doit pas perdre le dernier nœud placé
  window.addEventListener('pagehide', ()=>{
    wsAutoSave(false);
    if(WS.win && !WS.win.closed){ try{ WS.win.close(); }catch(e){} }
  });
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='hidden') wsAutoSave(false);
    wsNoteUpdate();
  });

  // le navigateur prévient les AUTRES onglets du même site à chaque écriture :
  // de quoi se mettre en retrait tout de suite, sans attendre notre prochaine tentative
  window.addEventListener('storage', e=>{
    if(e.key !== WS_KEY_SESSION || !e.newValue) return;
    let rec = null;
    try{ rec = JSON.parse(e.newValue); }catch(err){ return; }
    if(!rec || rec.by === WS.tabId) return;
    if(rec.savedAt && rec.savedAt === WS.seenAt) return;
    wsGoPassive();
  });
}
