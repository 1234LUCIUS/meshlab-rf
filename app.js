/* =========================================================================
   MeshLab RF — Interface (carte, panneaux, journal, dashboard, comparateur)
   Dépend de geo.js (données géographiques, propagation) et engine.js
   (moteur à événements discrets, protocoles).
   ========================================================================= */

const sim = new SimulationEngine();
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120];
const PKT_COLORS = {MESSAGE:'#49c8e8', BROADCAST:'#5b8def', POSITION:'#8aa0b3', TELEMETRY:'#8aa0b3', NODEINFO:'#b18cf0',
  ADVERT_ZERO:'#b18cf0', ADVERT_FLOOD:'#b18cf0', ACK:'#3ecf8e', PATH:'#3ecf8e'};
const ROLE_COLORS = {client:'#49c8e8', router:'#f0a742', repeater:'#b18cf0'};
const LOG_TAGS = ['GEN','ADVERT','TX','RX','RELAY','SUPPR','DELIVERED','RETX','DROP','DUTY','PATH'];
const TAG_HELP = {
  GEN:'Création d’un paquet par un nœud (message, position, télémétrie, ACK…)',
  ADVERT:'Création d’un advert (MeshCore) ou d’un NodeInfo (Meshtastic)',
  TX:'Début d’une émission radio (masqué par défaut : RX donne le résultat)',
  RX:'Fin d’une émission : quels nœuds l’ont reçue, lesquels l’ont perdue et pourquoi, combien l’avaient déjà',
  RELAY:'Un nœud qui vient de recevoir le paquet programme son relais',
  SUPPR:'Meshtastic : relais annulé, le nœud a entendu un voisin relayer avant lui',
  DELIVERED:'Le destinataire final a reçu le paquet',
  RETX:'Accusés de réception : renvoi, ACK implicite, échec',
  DROP:'Paquet abandonné : file d’émission pleine, ou plus aucune copie en circulation sans livraison',
  DUTY:'Émission retardée par la limite réglementaire de duty cycle',
  PATH:'MeshCore : chemin appris ou oublié'
};

const ui = {
  map:null, canvas:null, layers:{}, markers:new Map(),
  addNodeMode:null,
  send:{on:false, type:'BROADCAST', size:40, src:null},
  pickDestFor:null,
  selectedA:null, selectedB:null, selectedPacket:null,
  pedago:true, expert:false,
  playing:false, speedIdx:3, lastT:performance.now(), lastRefresh:0,
  closed:new Set(['scenarios','advanced']),
  logFilter:new Set(LOG_TAGS.filter(t=>t!=='TX')), logDirty:true,
  geo:{demStatus:'—', coverStatus:'Non chargée', loadingDem:false, loadingCover:false, showCover:true},
  autoName:true,                 // nommer les nœuds d'après la commune la plus proche
  linksVer:-1, anims:[], dashInited:false, charts:{}, cmpCharts:{}, cmpN:100, ign:null
};

/* ---------------- helpers ---------------- */
// Le panneau du bas peut avoir été déplacé dans une fenêtre détachée (workspace.js) :
// sans racine explicite, on cherche dans la page puis dans cette fenêtre, de sorte que
// tout le code d'affichage continue de fonctionner sans savoir où se trouve le panneau.
const $ = (sel,root)=> root ? root.querySelector(sel)
  : (document.querySelector(sel) || (WS.doc ? WS.doc.querySelector(sel) : null));
const $all = (sel,root)=> root ? [...root.querySelectorAll(sel)]
  : [...document.querySelectorAll(sel), ...(WS.doc ? WS.doc.querySelectorAll(sel) : [])];
const fmt = (n,d=1)=>(n===undefined||n===null||Number.isNaN(n))?'–':Number(n).toFixed(d);
const esc = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
function fmtTime(ms){
  const s=Math.floor(ms/1000);
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60].map(v=>String(v).padStart(2,'0')).join(':');
}
function fmtDist(m){ return m<1000 ? Math.round(m)+' m' : fmt(m/1000, m<10000?2:1)+' km'; }
function roleLabel(r){
  return sim.protocol==='meshcore'
    ? ({client:'Companion', router:'Room server', repeater:'Repeater'}[r]||r)
    : ({client:'Client', router:'Router', repeater:'Repeater (≈ ROUTER)'}[r]||r);
}
function coverLabel(c){ return c===COVER_TREES?'Arbres (forêt / bois)':c===COVER_BUILT?'Zone bâtie':'Dégagé / non renseigné'; }
function toast(msg, force=false){
  if(!ui.pedago && !force) return;
  const el=$('#pedagoToast'); el.innerHTML='🎓 '+msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(()=>el.classList.remove('show'), 7000);
}
function setHint(text){ const h=$('#mapModeHint'); h.textContent=text||''; h.classList.toggle('show', !!text); }

/* ---------------- onglets & barre du haut ---------------- */
$all('.toptab').forEach(t=>t.addEventListener('click',()=>{
  $all('.toptab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
  const tab=t.dataset.tab;
  $all('.tabpage').forEach(p=>p.classList.remove('active'));
  $('#page-'+tab).classList.add('active');
  if(tab==='sim'){ setTimeout(()=>ui.map && ui.map.invalidateSize(), 60); renderLeftPanel(); renderRightPanel(); }
  if(tab==='dash') renderDashboardPage();
  if(tab==='compare') renderComparatorPage();
}));

$('#protoSelect').addEventListener('change', e=>{
  sim.protocol=e.target.value;
  const cur=MODEM_PRESETS[sim.radioCfg.preset];
  if(cur && cur.proto && cur.proto!==sim.protocol) applyPreset(sim.protocol==='meshcore'?'mc_eu_narrow':'mt_long_fast', false);
  sim.reset(); sim.radioChanged(); clearTxClasses();
  renderLeftPanel(); renderMapLegend(); renderRightPanel(); refreshAllMarkers();
  toast(sim.protocol==='meshcore'
    ? "MeshCore : seuls les <b>répéteurs</b> relaient (companions jamais, room servers désactivés par défaut). Le 1er message vers un contact part en flood, le retour de chemin permet ensuite un routage direct. Réglages radio basculés sur le preset MeshCore EU/UK Narrow."
    : "Meshtastic : tous les nœuds relaient par <b>inondation gérée</b> — un client qui entend un doublon annule son relais, les routeurs relaient tôt et n'annulent jamais. Preset LONG_FAST appliqué.");
});
$('#btnPedago').addEventListener('click',()=>{ ui.pedago=!ui.pedago; $('#btnPedago').classList.toggle('on',ui.pedago); if(ui.pedago){ ui.expert=false; $('#btnExpert').classList.remove('on'); } renderLeftPanel(); renderRightPanel(); });
$('#btnExpert').addEventListener('click',()=>{ ui.expert=!ui.expert; $('#btnExpert').classList.toggle('on',ui.expert); if(ui.expert){ ui.pedago=false; $('#btnPedago').classList.remove('on'); ui.closed.delete('advanced'); } renderLeftPanel(); renderRightPanel(); });
$('#btnPedago').classList.add('on');

/* ---------------- carte ---------------- */
function initMap(){
  ui.map=L.map('map',{zoomControl:true, attributionControl:true, preferCanvas:false}).setView([48.8566,2.3522],12);
  ui.canvas=L.canvas({padding:0.3});
  // fonds de carte utilisables sans clé API (CARTO en exige désormais une)
  const esri = path => `https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`;
  const base={
    'Sombre (Esri)': L.tileLayer(esri('Canvas/World_Dark_Gray_Base'),{maxNativeZoom:16, maxZoom:19, attribution:'Fond &copy; Esri, HERE, Garmin, &copy; OpenStreetMap'}),
    'Topographique (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{maxNativeZoom:17, maxZoom:19, attribution:'&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)'}),
    'Satellite (Esri)': L.tileLayer(esri('World_Imagery'),{maxZoom:19, attribution:'Imagerie &copy; Esri'}),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19, attribution:'&copy; OpenStreetMap'})
  };
  base['Sombre (Esri)'].addTo(ui.map);
  ui.baseLayers=base; ui.baseName='Sombre (Esri)';        // retenus pour la sauvegarde de la vue

  // Noms de villes et de lieux : les fonds Esri n'en ont pas, on superpose leur couche "Reference".
  // Panneau dédié au-dessus de la végétation et des animations, sous les nœuds, sans capter les clics.
  ui.map.createPane('labels');
  ui.map.getPane('labels').style.zIndex=450;
  ui.map.getPane('labels').style.pointerEvents='none';
  const LABELS_FOR={
    'Sombre (Esri)': ()=>L.tileLayer(esri('Canvas/World_Dark_Gray_Reference'),{pane:'labels', maxNativeZoom:16, maxZoom:19}),
    'Satellite (Esri)': ()=>L.tileLayer(esri('Reference/World_Boundaries_and_Places'),{pane:'labels', maxZoom:19})
    // OpenTopoMap et OpenStreetMap affichent déjà les noms
  };
  ui.layers.labels=L.layerGroup().addTo(ui.map);
  const setLabelsFor=name=>{ ui.layers.labels.clearLayers(); if(LABELS_FOR[name]) LABELS_FOR[name]().addTo(ui.layers.labels); };
  setLabelsFor('Sombre (Esri)');
  ui.map.on('baselayerchange', e=>{ ui.baseName=e.name; setLabelsFor(e.name); });
  ui.setBaseLayer=name=>{                                  // utilisé au chargement d'une sauvegarde
    const l=base[name]; if(!l) return;
    Object.values(base).forEach(x=>{ if(x!==l && ui.map.hasLayer(x)) ui.map.removeLayer(x); });
    if(!ui.map.hasLayer(l)) l.addTo(ui.map);
    ui.baseName=name; setLabelsFor(name);
  };

  ui.layers.cover=L.layerGroup().addTo(ui.map);
  // traits permanents de qualité des liaisons : au-dessus de la végétation, sous les noms et les nœuds
  ui.map.createPane('radio');
  ui.map.getPane('radio').style.zIndex=420;
  ui.radioCanvas=L.canvas({pane:'radio', padding:0.3, tolerance:4});
  ui.layers.radio=L.layerGroup().addTo(ui.map);
  ui.layers.links=L.layerGroup().addTo(ui.map);
  ui.layers.path=L.layerGroup().addTo(ui.map);
  ui.layers.nodes=L.layerGroup().addTo(ui.map);
  ui.layers.pkt=L.layerGroup().addTo(ui.map);
  L.control.layers(base, {'Liaisons radio (vert / orange / rouge)':ui.layers.radio, 'Noms des villes et lieux':ui.layers.labels, 'Végétation & bâti (OSM)':ui.layers.cover, 'Chemin du paquet sélectionné':ui.layers.path}, {position:'bottomright'}).addTo(ui.map);
  ui.map.on('overlayadd overlayremove', e=>{
    if(e.layer===ui.layers.cover){ ui.geo.showCover=ui.map.hasLayer(ui.layers.cover); }
    if(e.layer===ui.layers.radio){ ui.radioSig=null; drawRadioLinks(); }
  });

  ui.map.on('click', e=>{
    if(ui.addNodeMode){
      const n=sim.addNode(e.latlng.lat, e.latlng.lng, {role:ui.addNodeMode});
      drawNode(n); afterTopologyChange();
      toast(`Nœud ${esc(n.label)} placé (${roleLabel(n.role)}, antenne à ${n.heightM} m). Cliquez encore pour en ajouter, ou sélectionnez-le pour modifier sa hauteur d'antenne.`);
    } else if(ui.send.on && ui.send.src){
      ui.send.src=null; highlightSelection(); updateModeHint();
    } else if(ui.selectedA && !ui.send.on && !ui.pickDestFor){
      // clic dans le vide : on désélectionne le nœud, la carte et le tableau montrent à nouveau toutes les liaisons
      ui.selectedA=null; ui.selectedB=null;
      renderRightPanel(); highlightSelection(); renderLogFilters(); renderLogList(true);
    }
  });
}

// Traits de liaison : vert = bonne, orange = en limite, rouge = impossible.
// Nœud sélectionné : toutes ses liaisons, y compris impossibles. Sinon : liaisons utilisables, et les impossibles
// seulement pour les petits réseaux (≤ 25 nœuds) ou à courte distance, pour ne pas noyer la carte.
function drawRadioLinks(){
  const layer=ui.layers.radio; if(!layer) return;
  const sel=ui.selectedA && !ui.selectedPacket ? sim.nodeById(ui.selectedA) : null;
  const visible=ui.map.hasLayer(layer);
  const sig=[visible, sim.links.version, sim.links.dirty, sel?sel.id:0, ui.selectedB||0, sim.nodes.length, sim.nodes.filter(n=>n.active).length].join('|');
  if(sig===ui.radioSig) return;
  ui.radioSig=sig;
  layer.clearLayers();
  if(!visible || sim.links.dirty) return;
  const nodes=sim.nodes.filter(n=>n.active);
  if(nodes.length<2) return;
  const pairs=[];
  if(sel) nodes.forEach(n=>{ if(n!==sel) pairs.push([sel,n]); });
  else if(nodes.length<=25){ for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) pairs.push([nodes[i],nodes[j]]); }
  else {
    const shortM=flatRangeKm('client','client')*1000*0.5;
    const ids=new Set(nodes.map(n=>n.id));
    for(const k of sim.links.pairs.keys()){
      const a=sim.nodeById(Math.floor(k/1048576)), b=sim.nodeById(k%1048576);
      if(a && b && ids.has(a.id) && ids.has(b.id)) pairs.push([a,b]);
    }
    pairs.splice(0, pairs.length, ...pairs.filter(([a,b])=>{ const q=sim.links.quality(a,b); return q.state!=='none' || q.distM<=shortM; }));
  }
  const items=pairs.map(([a,b])=>({a,b,q:sim.links.quality(a,b)}));
  const order={none:0, fair:1, good:2};                   // rouges dessinés d'abord, verts par-dessus
  items.sort((x,y)=>order[x.q.state]-order[y.q.state]);
  const MAX=5000;
  for(const {a,b,q} of items.slice(-MAX)){
    const st=LINK_STATE[q.state], isSel=(ui.selectedB && ((a.id===ui.selectedA&&b.id===ui.selectedB)||(b.id===ui.selectedA&&a.id===ui.selectedB)));
    const line=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{renderer:ui.radioCanvas, color:st.color,
      weight: isSel?5 : q.state==='good'?2.4 : q.state==='fair'?2 : 1.4,
      opacity: q.state==='none' ? (sel?0.75:0.5) : 0.85, dashArray: q.state==='none'?'4 6':null});
    line.bindTooltip(`<b>${nodeName(a.id)} ↔ ${nodeName(b.id)}</b> · ${fmtDist(q.distM)}<br>Liaison <b>${st.label}</b> : ${st.help}<br>`
      + (q.computed ? `${nodeName(b.id)} ${q.mAB>=0?'reçoit':'ne reçoit pas'} ${nodeName(a.id)} (${fmtMargin(q.mAB)}) · ${nodeName(a.id)} ${q.mBA>=0?'reçoit':'ne reçoit pas'} ${nodeName(b.id)} (${fmtMargin(q.mBA)})${q.state!=='good'?`<br>Principale perte : ${linkCause(q)}`:''}` : 'Trop loin : liaison non calculée')
      + `<br><i>Clic : bilan de liaison détaillé</i>`, {sticky:true, className:'node-label'});
    line.on('click', ev=>{
      L.DomEvent.stopPropagation(ev);
      ui.selectedPacket=null; ui.selectedA=a.id; ui.selectedB=b.id; ui.ign=null;
      renderRightPanel('link'); highlightSelection();
    });
    line.addTo(layer);
  }
}

function nodeIcon(n){
  const size = n.role==='repeater'?16 : n.role==='router'?14 : 12;
  return L.divIcon({className:'', html:`<div class="node-marker ${n.role}${n.active?'':' inactive'}" style="width:${size}px;height:${size}px"></div>`, iconSize:[size,size], iconAnchor:[size/2,size/2]});
}
function drawNode(n){
  const m=L.marker([n.lat,n.lng],{icon:nodeIcon(n), draggable:true, keyboard:false}).addTo(ui.layers.nodes);
  m.bindTooltip(()=>`${esc(n.label)} · ${roleLabel(n.role)} · ${n.heightM} m`, {direction:'top', className:'node-label', offset:[0,-6]});
  m.on('click', ev=>{ L.DomEvent.stopPropagation(ev); onNodeClick(n, ev.originalEvent); });
  m.on('dragend', ()=>{
    const ll=m.getLatLng(); n.lat=ll.lat; n.lng=ll.lng;
    sim.nodeMoved(n); afterTopologyChange();
    if(ui.selectedA===n.id || ui.selectedB===n.id) renderRightPanel();
  });
  ui.markers.set(n.id,m);
}
function markerEl(id){ const m=ui.markers.get(id); const el=m&&m.getElement(); return el?el.querySelector('.node-marker'):null; }
function refreshMarker(n){ const m=ui.markers.get(n.id); if(m){ m.setIcon(nodeIcon(n)); } highlightSelection(); }
function refreshAllMarkers(){ sim.nodes.forEach(n=>{ const m=ui.markers.get(n.id); if(m) m.setIcon(nodeIcon(n)); }); highlightSelection(); }
function removeMarker(id){ const m=ui.markers.get(id); if(m){ ui.layers.nodes.removeLayer(m); ui.markers.delete(id); } }
function highlightSelection(){
  ui.markers.forEach((m,id)=>{
    const dot=markerEl(id); if(!dot) return;
    dot.classList.toggle('selected', id===ui.selectedA || id===ui.selectedB);
    dot.classList.toggle('src', id===ui.send.src || id===ui.pickDestFor);
  });
  if(ui.selectedPacket) applyPacketHighlight(ui.selectedPacket);   // setIcon() recrée les marqueurs
  // la sélection filtre les traits de liaison et le tableau « Liaisons » (redessinés seulement si nécessaire)
  drawRadioLinks();
  if((ui.bottomTab||'log')==='links'){ renderLogFilters(); renderLinksTable(); }
}
function clearTxClasses(){ $all('.node-marker.tx,.node-marker.lost').forEach(el=>el.classList.remove('tx','lost')); }

function onNodeClick(n, ev){
  if(ui.pickDestFor){ // choix du destinataire depuis l'inspecteur
    const src=sim.nodeById(ui.pickDestFor); ui.pickDestFor=null;
    if(src && src.id!==n.id) manualSend(src, n, 'MESSAGE');
    updateModeHint(); highlightSelection(); return;
  }
  if(ui.send.on){ handleSendClick(n); return; }
  if(ui.selectedA && ui.selectedA!==n.id && ev && ev.shiftKey){
    ui.selectedB=n.id; ui.selectedPacket=null; ui.ign=null; renderRightPanel('link');
  } else {
    ui.selectedA=n.id; ui.selectedB=null; ui.selectedPacket=null; ui.layers.path.clearLayers();
    renderRightPanel('node');
  }
  highlightSelection();
}

/* ---------------- envoi manuel ---------------- */
function sendTypeFor(kind){
  if(kind==='ADVERT') return sim.protocol==='meshcore' ? 'ADVERT_FLOOD' : 'NODEINFO';
  return kind;
}
function handleSendClick(n){
  if(ui.send.type==='MESSAGE'){
    if(!ui.send.src || ui.send.src===n.id){ ui.send.src=n.id; highlightSelection(); updateModeHint(); return; }
    const src=sim.nodeById(ui.send.src); ui.send.src=null;
    if(src) manualSend(src, n, 'MESSAGE');
    highlightSelection(); updateModeHint(); return;
  }
  manualSend(n, null, sendTypeFor(ui.send.type));
}
function manualSend(src, dst, type){
  if(!src.active){ toast(`${esc(src.label)} est inactif : réactivez-le dans l'inspecteur pour émettre.`, true); return; }
  const size = type==='ACK' ? 8 : (type==='ADVERT_FLOOD'||type==='NODEINFO') ? 110 : ui.send.size;
  const p=sim.originate(src, dst, type, size, null, null, {manual:true});
  if(!p) return;
  const el=markerEl(src.id); if(el){ el.classList.add('src'); setTimeout(()=>highlightSelection(), 900); }
  ui.selectedPacket=p; ui.selectedA=src.id; ui.selectedB=null;
  renderRightPanel();
  if(!ui.playing) togglePlay();
  if(sim.traffic.msgPerHour()>0 || sim.traffic.background){
    toast(`Paquet #${p.id} créé par ${esc(src.label)}. Astuce : passez le trafic sur « Aucun » et décochez le trafic de fond pour suivre ce paquet seul, et ralentissez la vitesse (×0,25).`);
  }
}
function updateModeHint(){
  if(ui.addNodeMode) return setHint(`Cliquez sur la carte pour placer un nœud « ${roleLabel(ui.addNodeMode)} » (Échap pour arrêter)`);
  if(ui.pickDestFor) return setHint(`Cliquez sur le nœud destinataire du message de ${sim.nodeById(ui.pickDestFor)?.label||'?'} (Échap pour annuler)`);
  if(ui.send.on){
    if(ui.send.type==='MESSAGE') return setHint(ui.send.src ? `Source : ${sim.nodeById(ui.send.src)?.label} — cliquez sur le destinataire` : 'Envoi manuel : cliquez sur le nœud SOURCE du message');
    return setHint(`Envoi manuel : cliquez sur un nœud pour émettre ${ui.send.type==='ADVERT'?'un advert':'un message de canal'}`);
  }
  setHint('');
}
document.addEventListener('keydown', e=>{
  if(e.target.matches('input,select,textarea')) return;
  if(e.key==='Escape'){ ui.addNodeMode=null; ui.pickDestFor=null; ui.send.src=null; $all('[data-add]').forEach(x=>x.classList.remove('active')); highlightSelection(); updateModeHint(); }
  if(e.key===' ' && $('#page-sim').classList.contains('active')){ e.preventDefault(); togglePlay(); }
});

/* ---------------- animations ---------------- */
sim.onTxStart = tx=>{
  const el=markerEl(tx.node.id); if(el) el.classList.add('tx');
  if(!$('#page-sim').classList.contains('active')) return;
  const color=PKT_COLORS[tx.item.packet.type]||'#49c8e8';
  const dur=clamp(tx.air/SPEEDS[ui.speedIdx], 150, 4000);
  let k=0;
  for(const [rid] of tx.rx){
    if(ui.anims.length>350 || k++>40) break;
    const r=sim.nodeById(rid); if(!r) continue;
    const dot=L.circleMarker([tx.node.lat,tx.node.lng],{renderer:ui.canvas, radius:3.2, stroke:false, fillColor:color, fillOpacity:1, interactive:false}).addTo(ui.layers.pkt);
    const line=L.polyline([[tx.node.lat,tx.node.lng],[r.lat,r.lng]],{renderer:ui.canvas, color, weight:1, opacity:.35, interactive:false}).addTo(ui.layers.links);
    ui.anims.push({dot, line, from:tx.node, to:r, t0:performance.now(), dur});
  }
};
sim.onTxEnd = tx=>{
  const el=markerEl(tx.node.id); if(el && tx.node.txUntil<=sim.timeMs) el.classList.remove('tx');
  for(const [rid,rec] of tx.rx){
    if(rec.lost!=='collision') continue;
    const r=markerEl(rid); if(!r) continue;
    r.classList.add('lost'); setTimeout(()=>r.classList.remove('lost'), 700);
  }
};
function stepAnims(now){
  for(let i=ui.anims.length-1;i>=0;i--){
    const a=ui.anims[i], f=Math.min(1,(now-a.t0)/a.dur);
    a.dot.setLatLng([a.from.lat+(a.to.lat-a.from.lat)*f, a.from.lng+(a.to.lng-a.from.lng)*f]);
    if(f>=1){ ui.layers.pkt.removeLayer(a.dot); ui.layers.links.removeLayer(a.line); ui.anims.splice(i,1); }
  }
}

/* ---------------- données géographiques ---------------- */
let geoTimer=null;
function afterTopologyChange(){
  const b=Geo.bboxOf(sim.nodes,600);
  // on bloque le calcul des liaisons le temps de charger le relief (rapide) ; l'occupation du sol
  // (Overpass, parfois lente) arrive en arrière-plan et déclenche un recalcul à son arrivée
  if(b && sim.demMode==='real' && !sim.pickRealDem(b).covers(b)) sim.geoBusy=true;
  if(b && sim.coverEnabled) sim.pickCover(b);
  // nœuds déplacés hors de la zone qui a échoué : on retente tout de suite pour la nouvelle zone
  if(b && ui.geo.coverFailed && !Geo.bboxContains(ui.geo.coverFailedArea, b)){ ui.geo.coverFailed=false; clearTimeout(ui.geo.coverRetryTimer); }
  clearTimeout(geoTimer); geoTimer=setTimeout(refreshGeoData, 300);
  renderMapOverlay(); updateRangeEstimate(); updateIntervalUI();
}
async function refreshGeoData(){
  const b=Geo.bboxOf(sim.nodes,600);
  if(!b){ if(!ui.geo.demJobs) sim.geoBusy=false; return; }
  // plusieurs chargements peuvent se chevaucher (nœuds ajoutés pendant un téléchargement) :
  // le calcul des liaisons reste bloqué tant qu'il en reste un en cours
  ui.geo.demJobs=(ui.geo.demJobs||0)+1;
  try{
    if(sim.demMode==='real'){
      // deux passes au plus : si l'IGN se révèle hors couverture pendant le téléchargement,
      // pickRealDem bascule sur le SRTM et la seconde passe charge la bonne source
      for(let pass=0; pass<2; pass++){
        const dem=sim.pickRealDem(b);
        if(dem.covers(b)) break;
        ui.geo.loadingDem=true; sim.geoBusy=true;
        const src=demSourceLabel(dem);
        setGeoStatus('dem',`Chargement du relief (${src})…`);
        const r=await dem.ensure(b,(d,t)=>setGeoStatus('dem',`Chargement du relief ${src} : ${d}/${t} tuiles`));
        sim.envChanged();
        // source abandonnée en cours de route (tuiles hors couverture) : on recommence avec l'autre
        if(sim.pickRealDem(b)!==dem){
          toast(`Relief IGN indisponible sur cette zone : passage au SRTM mondial (~30 m).`, true);
          continue;
        }
        announceDemSource(dem);
        if(r.failed) toast(`⚠ ${r.failed} tuile(s) de relief n'ont pas pu être chargées : les liaisons concernées sont calculées sans relief (terrain plat) et risquent d'être trop optimistes. Nouvel essai automatique dans 30 s.`, true);
        break;
      }
    }
    updateDemStatus();
  } finally {
    ui.geo.demJobs--;
    if(!ui.geo.demJobs){ ui.geo.loadingDem=false; sim.geoBusy=false; }
  }
  // tuiles en échec : nouvel essai différé
  if(sim.demMode==='real' && sim.realDem.missingTiles(b)){ clearTimeout(ui.geo.retryTimer); ui.geo.retryTimer=setTimeout(afterTopologyChange, sim.realDem.retryMs+500); }
  // noms des nœuds : une requête couvre toute la zone, on la garde largement au-delà
  // des nœuds actuels pour ne pas la refaire au moindre déplacement
  if(ui.autoName && sim.communes.applies(b) && !sim.communes.covers(b) && !ui.geo.loadingCommunes){
    ui.geo.loadingCommunes=true;
    const bigC=Geo.bboxOf(sim.nodes, 8000);
    sim.communes.load(bigC)
      .then(r=>{
        const n=applyAutoNames();
        if(!ui.geo.communeToast && n){
          ui.geo.communeToast=true;
          toast(`${n} nœud(s) nommés d'après la commune la plus proche (${r.count} communes chargées depuis l'IGN). <b>R</b> répéteur, <b>N</b> router, <b>C</b> client — puis les 4 premières lettres de la commune. Un nom que vous saisissez vous-même n'est jamais réécrit.`);
        }
      })
      .catch(e=>{ setGeoStatus('cover', ui.geo.coverStatus); console.warn('Communes IGN indisponibles :', e.message); })
      .finally(()=>{ ui.geo.loadingCommunes=false; });
  } else if(ui.autoName && sim.communes.pts.length) applyAutoNames();

  if(sim.coverEnabled && (!sim.pickCover(b).covers(b) || ui.geo.forceCover) && !ui.geo.coverFailed && !ui.geo.loadingCover){
    ui.geo.forceCover=false;
    // marge large pour éviter de recharger au moindre déplacement
    const big=Geo.bboxOf(sim.nodes, Math.max(2500, Math.sqrt(Geo.bboxAreaKm2(b))*1000*0.25));
    ui.geo.loadingCover=true;
    try{
      const src = sim.pickCover(big);
      await src.load(big, s=>setGeoStatus('cover',s));
      sim.envChanged(); drawCoverOverlay();
      ui.geo.coverRetryS=0; ui.geo.coverFailToast=false; clearTimeout(ui.geo.coverRetryTimer);
      toast(src.id==='ign'
        ? `Végétation et bâti chargés depuis l'<b>IGN BD TOPO</b> : ${fmt(src.stats.treesPct,0)} % d'arbres, ${fmt(src.stats.builtPct,0)} % de bâti sur la zone. Service sans quota, plus fiable et plus complet qu'OpenStreetMap sur la France.`
        : `Occupation du sol chargée (${src.stats.polygons} polygones OSM) : les liaisons sont recalculées avec la végétation et le bâti.`);
    }catch(err){
      // serveurs saturés : nouvel essai automatique, de plus en plus espacé (30 s, 1 min, 2 min, 4 min, puis 5 min)
      ui.geo.coverFailed=true;
      ui.geo.coverFailedArea=big;
      ui.geo.coverRetryS=Math.min(300, (ui.geo.coverRetryS||15)*2);
      ui.geo.coverRetryAt=Date.now()+ui.geo.coverRetryS*1000;
      setGeoStatus('cover',`⚠ ${esc(err.message)} — nouvel essai automatique dans ${fmtInterval(ui.geo.coverRetryS)}`);
      if(!ui.geo.coverFailToast){
        ui.geo.coverFailToast=true;
        toast(`Végétation et bâti non chargés : ${esc(err.message)}. La simulation continue sans eux ; nouvel essai automatique dans ${fmtInterval(ui.geo.coverRetryS)}.`, true);
      }
      clearTimeout(ui.geo.coverRetryTimer);
      // l'IGN s'est mis en retrait tout seul (downUntil) : le prochain essai passera par
      // OpenStreetMap, autant le lancer tout de suite plutôt qu'attendre la temporisation
      const delayS = (sim.cover.id==='ign' && !sim.ignCover.applies(big)) ? 1 : ui.geo.coverRetryS;
      ui.geo.coverRetryTimer=setTimeout(()=>{ ui.geo.coverFailed=false; afterTopologyChange(); }, delayS*1000);
    }finally{ ui.geo.loadingCover=false; }
  }
  if(!ui.geo.coverFailed) updateCoverStatus();
  const nb=Geo.bboxOf(sim.nodes,600);
  if(nb && ((sim.demMode==='real' && !sim.pickRealDem(nb).covers(nb)) || (sim.coverEnabled && !sim.pickCover(nb).covers(nb) && !ui.geo.coverFailed && !ui.geo.loadingCover))) afterTopologyChange();
  if(ui.selectedA) renderRightPanel();
}
function demSourceLabel(d){ return d && d.id==='ign' ? 'IGN RGE ALTI' : 'SRTM'; }
// mise en garde sur le modèle de relief employé : le SRTM voit en partie la canopée, pas le RGE ALTI
function demBiasText(){
  if(sim.demMode!=='real') return '';
  return sim.realDem.id==='ign'
    ? 'Le RGE ALTI est un modèle de terrain nu : arbres et bâti ne sont comptés qu’une fois.'
    : 'Attention : le SRTM intègre déjà partiellement la canopée et les toits, le sol y est donc un peu trop haut.';
}
// un seul message quand la source de relief change réellement
function announceDemSource(d){
  if(!d || ui.geo.demSrc===d.id) return;
  const first=ui.geo.demSrc===undefined;
  ui.geo.demSrc=d.id;
  if(d.id==='ign') toast(`Relief IGN RGE ALTI® : modèle de terrain nu à ~${Math.round(d.resolutionM)} m, sans arbres ni bâtiments (ils sont comptés séparément).`);
  else if(!first) toast(`Relief SRTM mondial (~${Math.round(d.resolutionM)} m) : hors couverture IGN ou zone trop vaste.`);
}
function setGeoStatus(kind,text){
  if(kind==='dem') ui.geo.demStatus=text; else ui.geo.coverStatus=text;
  const el=$(kind==='dem'?'#demStatus':'#coverStatus'); if(el) el.innerHTML=text;
}
function updateDemStatus(){
  const bias=$('#demBiasHint'); if(bias) bias.textContent=demBiasText();
  if(sim.demMode==='none') return setGeoStatus('dem','Relief ignoré : sol à 0 m (courbure terrestre et réflexion sol conservées).');
  if(sim.demMode==='synthetic') return setGeoStatus('dem','⚠ Relief inventé (bruit procédural) — ne correspond pas au terrain réel.');
  const d=sim.realDem, n=[...d.grid.values()].filter(Boolean).length;
  if(!n) return setGeoStatus('dem', sim.demPrefer==='srtm'
    ? 'Placez des nœuds : le relief SRTM de la zone sera téléchargé automatiquement.'
    : 'Placez des nœuds : le relief sera téléchargé automatiquement (IGN RGE ALTI en France, SRTM ailleurs).');
  const kind = d.id==='ign' ? 'IGN RGE ALTI <b>terrain nu</b>' : 'SRTM <b>surface</b> (canopée et bâti partiellement inclus)';
  setGeoStatus('dem', `✓ ${n} tuile(s) ${kind} · zoom ${d.z} · ~${Math.round(d.resolutionM)} m/pixel${d.failedTiles?` · <span style="color:var(--amber)">${d.failedTiles} en échec</span>`:''}`);
}
function coverSourceLabel(c){ return c && c.id==='ign' ? 'IGN BD TOPO' : 'OpenStreetMap'; }
function updateCoverStatus(){
  if(!sim.coverEnabled) return setGeoStatus('cover','Désactivée : ni végétation ni bâti pris en compte.');
  if(ui.geo.coverFailed || ui.geo.loadingCover) return;
  const c=sim.cover;
  if(!c.cells) return setGeoStatus('cover', sim.coverPrefer==='osm'
    ? 'Placez des nœuds : forêts et zones bâties seront chargées depuis OpenStreetMap.'
    : 'Placez des nœuds : forêts et zones bâties seront chargées automatiquement (IGN BD TOPO en France, OpenStreetMap ailleurs).');
  const b=Geo.bboxOf(sim.nodes,600);
  const warn = b && !c.covers(b) ? ' · <span style="color:var(--amber)">des nœuds sont hors zone</span>' : '';
  const src = c.id==='ign' ? 'IGN BD TOPO' : `${c.stats.polygons} polygones OSM`;
  setGeoStatus('cover', `✓ ${src} · arbres ${fmt(c.stats.treesPct,0)} % · bâti ${fmt(c.stats.builtPct,0)} % · maille ${Math.round(c.cellM)} m${warn}`);
}
function drawCoverOverlay(){
  ui.layers.cover.clearLayers();
  const c=sim.cover; if(!c.overlayUrl || !sim.coverEnabled) return;
  L.imageOverlay(c.overlayUrl, [[c.bbox.s,c.bbox.w],[c.bbox.n,c.bbox.e]], {opacity:0.6, interactive:false}).addTo(ui.layers.cover);
}

/* ---------------- incrustations carte ---------------- */
function renderMapOverlay(){
  const prof=REG_PROFILES[sim.regProfile];
  const active=sim.nodes.filter(n=>n.active);
  const maxDuty = active.length ? Math.max(...active.map(n=>n.currentDutyPct||0))*100 : 0;
  const dutyClass = !prof.dutyCycle ? '' : (maxDuty>prof.dutyCycle*100 ? 'over' : maxDuty>prof.dutyCycle*75 ? 'warn' : '');
  const T=sim.totals, dr = (T.msgDelivered+T.msgDropped) ? T.msgDelivered/(T.msgDelivered+T.msgDropped)*100 : null;
  let status='';
  if(sim.geoBusy) status=`<div class="ov-card busy"><b>Données géo</b><div class="big" style="font-size:12px">⏳ chargement…</div></div>`;
  else if(sim.links.dirty && sim.nodes.length) status=`<div class="ov-card busy"><b>Calcul des liaisons</b><div class="big" style="font-size:12px">⏳ ${Math.round(sim.links.progress*100)} %</div></div>`;
  const warns=geoWarnings();
  if(warns.length) status+=`<div class="ov-card warn" title="Les portées radio affichées ne tiennent pas compte de tout le terrain réel : elles sont probablement trop optimistes."><b>⚠ Données géographiques incomplètes</b>${warns.map(w=>`<div class="warnline">${w}</div>`).join('')}</div>`;
  $('#mapOverlay').innerHTML=`
    <div class="ov-card"><b>Nœuds</b><div class="big">${active.length}<small> / ${sim.nodes.length}</small></div></div>
    <div class="ov-card"><b>Temps simulé</b><div class="big">${fmtTime(sim.timeMs)}</div></div>
    <div class="ov-card" title="Nombre d'émissions radio simultanées à cet instant (pic sur la simulation)"><b>En émission</b><div class="big" style="color:${sim.activeTx.length>3?'var(--amber)':'var(--text-0)'}">${sim.activeTx.length}<small> pic ${T.peakTx}</small></div></div>
    <div class="ov-card" title="Messages directs livrés, et pourcentage parmi les messages terminés (livrés + perdus). Les messages encore en route ne sont pas comptés."><b>Messages livrés ${FID.badge('proto')}</b><div class="big">${T.msgDelivered}<small> ${dr===null?'':fmt(dr,0)+' %'}</small></div></div>
    <div class="ov-card" title="Émissions dont au moins une réception utile a été perdue par collision"><b>Collisions</b><div class="big" style="color:${T.collisions?'var(--red)':'var(--text-0)'}">${T.collisions}<small> / ${T.tx} TX</small></div></div>
    ${ackActive()?`<div class="ov-card" title="Messages renvoyés faute d'ACK / échecs définitifs"><b>Renvois</b><div class="big" style="color:${T.retx?'var(--amber)':'var(--text-0)'}">${sim.cfg.retxEnabled?T.retx:'off'}<small> échecs ${T.ackFailures}</small></div></div>`:''}
    <div class="ov-card duty ${dutyClass}"><b>Duty cycle max ${FID.badge('reg')}</b><div class="big">${prof.dutyCycle? fmt(maxDuty,2)+' %':'N/A'}</div></div>
    ${status}`;
}
function ackActive(){ return sim.protocol==='meshcore' || sim.cfg.mtAckEnabled; }
// ce qui manque pour que les liaisons reflètent le terrain réel
function geoWarnings(){
  const out=[]; if(!sim.nodes.length || sim.geoBusy) return out;
  const b=Geo.bboxOf(sim.nodes,600);
  if(sim.demMode==='synthetic') out.push('Relief inventé (synthétique)');
  else if(sim.demMode==='none') out.push('Relief ignoré (terrain plat)');
  else { const m=sim.realDem.missingTiles(b); if(m) out.push(`Relief incomplet : ${m} tuile(s) non chargée(s)`); }
  if(!sim.coverEnabled) out.push('Végétation et bâti désactivés');
  else if(ui.geo.coverFailed){
    const s=Math.max(0,Math.round(((ui.geo.coverRetryAt||0)-Date.now())/1000));
    out.push(`Végétation et bâti non chargés (serveurs OpenStreetMap saturés${s?`, nouvel essai dans ${fmtInterval(s)}`:''})`);
  }
  else if(ui.geo.loadingCover) out.push('Végétation et bâti en cours de chargement');
  return out;
}
function renderMapLegend(){
  const items = sim.protocol==='meshtastic'
    ? [['client','Client (relaie, annule si doublon)'],['router','Router (relaie tôt)'],['repeater','Repeater (≈ Router)']]
    : [['client','Companion (ne relaie jamais)'],['router','Room server (ne relaie pas)'],['repeater','Repeater (relaie)']];
  $('#mapLegend').innerHTML = items.map(([c,l])=>`<div class="legend-item"><div class="legend-dot" style="background:${ROLE_COLORS[c]}"></div>${l}</div>`).join('')
    + `<div class="legend-item" title="${LINK_STATE.good.help}"><div class="legend-line good"></div>Liaison bonne</div>`
    + `<div class="legend-item" title="${LINK_STATE.fair.help}"><div class="legend-line fair"></div>En limite</div>`
    + `<div class="legend-item" title="${LINK_STATE.none.help}"><div class="legend-line bad"></div>Impossible</div>`
    + `<div class="legend-item"><div class="legend-ring tx"></div>En émission</div>`
    + `<div class="legend-item"><div class="legend-ring lost"></div>Collision</div>`
    + `<div class="legend-item"><div class="legend-dot" style="background:${PKT_COLORS.BROADCAST}"></div>Canal</div>`
    + `<div class="legend-item"><div class="legend-dot" style="background:${PKT_COLORS.MESSAGE}"></div>Direct</div>`
    + `<div class="legend-item"><div class="legend-dot" style="background:${PKT_COLORS.ACK}"></div>ACK / chemin</div>`
    + `<div class="legend-item"><div class="legend-dot" style="background:${PKT_COLORS.ADVERT_ZERO}"></div>Advert / NodeInfo</div>`;
}

/* ---------------- panneau gauche ---------------- */
function section(id, title, body){
  return `<div class="section ${ui.closed.has(id)?'closed':''}" data-sec="${id}"><div class="section-h"><b>${title}</b><span class="chev">▾</span></div><div class="section-b">${body}</div></div>`;
}
function renderLeftPanel(){
  const p=$('#leftPanel');
  const rc=sim.radioCfg, prof=REG_PROFILES[sim.regProfile];
  const D=DEFAULT_NODE_PROFILES;
  const bandWarn = prof.band && (rc.freqMHz<prof.band[0] || rc.freqMHz>prof.band[1]) ? `<div class="hint warn">⚠ ${rc.freqMHz} MHz est hors de la bande de ce profil (${prof.band[0]}–${prof.band[1]} MHz).</div>` : '';
  const erpOver = prof.maxErpDbm!=null ? sim.nodes.filter(n=>RadioModel.erpDbm(n)>prof.maxErpDbm).length : 0;
  const erpWarn = erpOver ? `<div class="hint warn">⚠ ${erpOver} nœud(s) dépassent ${prof.maxErpDbm} dBm ERP (puissance + gain − 2,15 dB).</div>` : '';
  const air=RadioModel.airtimeMs(60+(sim.protocol==='meshtastic'?16:2), rc.sf, rc.bwKHz, rc.cr, sim.cfg.preambleSym);

  p.innerHTML =
  section('nodes','Nœuds', `
    <div class="hint">Choisissez un type puis cliquez sur la carte. Glissez un nœud pour le déplacer, cliquez-le pour régler sa hauteur d'antenne. Maj+clic sur un 2ᵉ nœud : bilan de liaison.</div>
    <div class="btnrow">
      <div class="mbtn ${ui.addNodeMode==='client'?'active':''}" data-add="client">+ ${sim.protocol==='meshcore'?'Companion':'Client'}</div>
      <div class="mbtn ${ui.addNodeMode==='router'?'active':''}" data-add="router">+ ${sim.protocol==='meshcore'?'Room srv':'Router'}</div>
      <div class="mbtn ${ui.addNodeMode==='repeater'?'active':''}" data-add="repeater">+ Repeater</div>
    </div>
    <label class="check"><input type="checkbox" id="autoNameChk" ${ui.autoName?'checked':''}> Nommer les nœuds d'après la commune</label>
    <div class="hint" style="margin-top:0">Une lettre de rôle, un tiret, les 4 premières lettres de la commune la plus proche : <b style="color:var(--text-0)">R-ANDE</b> répéteur, <b style="color:var(--text-0)">N-ANDE</b> router / room server, <b style="color:var(--text-0)">C-ANDE</b> client / companion. Les communes viennent de l'IGN. Un nom que vous saisissez vous-même est conservé tel quel.</div>
    ${ui.autoName?`<div class="btnrow"><div class="mbtn" id="btnRename" title="Réattribue un nom à tous les nœuds, y compris ceux que vous avez renommés à la main">🏷 Renommer tous les nœuds</div></div>`:''}
    <div class="field" style="margin-top:10px"><label>Hauteur d'antenne par défaut (m, au-dessus du sol)</label>
      <div class="field-row mini3">
        <div><span class="mini-lbl">Client</span><input type="number" min="0" max="300" step="0.5" data-defh="client" value="${D.client.heightM}"></div>
        <div><span class="mini-lbl">Router</span><input type="number" min="0" max="300" step="0.5" data-defh="router" value="${D.router.heightM}"></div>
        <div><span class="mini-lbl">Repeater</span><input type="number" min="0" max="300" step="0.5" data-defh="repeater" value="${D.repeater.heightM}"></div>
      </div>
      <div class="btnrow"><div class="mbtn" id="btnApplyDefH" title="Applique ces hauteurs à tous les nœuds existants selon leur rôle">Appliquer à tous les nœuds</div></div>
    </div>
    <div class="field"><label>Grille <span class="val">N × N · espacement (m)</span></label>
      <div class="field-row"><input type="number" id="gridN" value="5" min="2" max="20" style="width:60px;flex:none"><input type="number" id="gridSpacing" value="900" min="100" max="10000"></div>
      <div class="btnrow"><div class="mbtn" id="btnGenGrid">Générer la grille</div></div>
    </div>
    <div class="field"><label>Aléatoire <span class="val" id="randCountLbl">30</span></label>
      <input type="range" id="randCount" min="5" max="1000" value="30">
      <div class="btnrow"><div class="mbtn" id="btnGenRandom">Générer aléatoirement</div></div>
    </div>
    <div class="btnrow"><div class="mbtn" id="btnClearNodes" style="color:var(--red)">🗑 Effacer tous les nœuds</div></div>
  `) +
  wsSection() +
  section('send','Envoi manuel', `
    <div class="btnrow"><div class="mbtn toggle ${ui.send.on?'active':''}" id="btnSendMode">${ui.send.on?'● Clic sur un nœud = envoi (actif)':'○ Activer : clic sur un nœud = envoi'}</div></div>
    <div class="chiprow" style="margin-top:8px">
      ${[['BROADCAST','Canal (broadcast)'],['MESSAGE','Message direct'],['ADVERT', sim.protocol==='meshcore'?'Advert flood':'NodeInfo']].map(([k,l])=>`<div class="chip ${ui.send.type===k?'active':''}" data-sendtype="${k}">${l}</div>`).join('')}
    </div>
    <div class="field" style="margin-top:8px"><label>Taille de la charge utile <span class="val" id="sendSizeLbl">${ui.send.size} o</span></label>
      <input type="range" id="sendSize" min="5" max="200" step="5" value="${ui.send.size}"></div>
    <div class="hint">${ui.send.type==='MESSAGE'?'Cliquez sur la source puis sur le destinataire.':'Chaque clic sur un nœud crée un paquet émis par ce nœud.'} La lecture démarre automatiquement et l'inspecteur suit le paquet.</div>
    <div class="btnrow"><div class="mbtn" id="btnQuiet" title="Trafic automatique sur « Aucun » et trafic de fond coupé">🔇 Couper tout le trafic automatique</div></div>
  `) +
  section('radio',`Radio ${FID.badge('phys')}`, `
    <div class="field"><label>Preset</label>
      <select id="presetSel">${Object.entries(MODEM_PRESETS).map(([k,v])=>`<option value="${k}" ${k===rc.preset?'selected':''}>${v.label}</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Fréquence (MHz)</label><input type="number" id="freqIn" step="0.001" value="${rc.freqMHz}"></div>
      <div class="field"><label>Coding rate</label><select id="crSel">${[1,2,3,4].map(c=>`<option value="${c}" ${c===rc.cr?'selected':''}>4/${4+c}</option>`).join('')}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>SF</label><select id="sfSel">${[7,8,9,10,11,12].map(s=>`<option value="${s}" ${s===rc.sf?'selected':''}>SF${s}</option>`).join('')}</select></div>
      <div class="field"><label>Bande</label><select id="bwSel">${[62.5,125,250,500].map(b=>`<option value="${b}" ${b===rc.bwKHz?'selected':''}>${b} kHz</option>`).join('')}</select></div>
    </div>
    <div class="kvmini"><span>Sensibilité</span><b>${fmt(sim.sensitivity(),1)} dBm</b></div>
    <div class="kvmini"><span>Airtime 60 o</span><b>${fmt(air.totalMs,0)} ms</b></div>
    <div class="kvmini"><span>Slot de contention</span><b>${fmt(sim.slotMs(),1)} ms</b></div>
    <div class="hint" id="rangeEstimate">…</div>
    <div class="field" style="margin-top:10px"><label>Réglementation ${FID.badge('reg')}</label>
      <select id="regSel">${Object.entries(REG_PROFILES).map(([k,v])=>`<option value="${k}" ${k===sim.regProfile?'selected':''}>${v.label}</option>`).join('')}</select>
      <div class="hint">${prof.note}</div>${bandWarn}${erpWarn}
    </div>
  `) +
  section('terrain','Terrain & environnement', `
    <div class="field"><label>Relief</label>
      <div class="chiprow">
        ${[['real','Réel'],['synthetic','Synthétique'],['none','Aucun']].map(([k,l])=>`<div class="chip ${sim.demMode===k?'active':''}" data-dem="${k}">${l}</div>`).join('')}
      </div>
      ${sim.demMode==='real'?`<select id="demPrefer" style="margin-top:6px" title="Le RGE ALTI de l'IGN est un modèle de terrain nu, plus fin que le SRTM, mais limité à la France et aux DOM">
        <option value="auto" ${sim.demPrefer==='auto'?'selected':''}>Auto — IGN (France) / SRTM</option>
        <option value="srtm" ${sim.demPrefer==='srtm'?'selected':''}>SRTM mondial uniquement</option>
      </select>`:''}
      <div class="statusline" id="demStatus">${ui.geo.demStatus}</div>
    </div>
    ${sim.demMode==='synthetic'?`
      <div class="field"><label>Rugosité <span class="val">${sim.syntheticDem.roughness}</span></label><input type="range" id="roughRange" min="0.2" max="0.8" step="0.05" value="${sim.syntheticDem.roughness}"></div>
      <div class="field"><label>Amplitude (m) <span class="val">${sim.syntheticDem.amplitude}</span></label><input type="range" id="ampRange" min="20" max="700" step="10" value="${sim.syntheticDem.amplitude}"></div>`:''}
    <div class="field"><label>Végétation & bâti ${FID.badge('est')}</label>
      <div class="btnrow"><div class="mbtn toggle ${sim.coverEnabled?'active':''}" id="coverToggle">${sim.coverEnabled?'● Végétation et bâti pris en compte':'○ Activer la végétation et le bâti'}</div>
      ${sim.coverEnabled?`<div class="mbtn" id="coverReload" title="Recharger pour la zone actuelle des nœuds" style="flex:none;min-width:0">↻</div>`:''}</div>
      ${sim.coverEnabled?`<select id="coverPrefer" style="margin-top:6px" title="La BD TOPO de l'IGN est plus complète que OpenStreetMap sur la France, et son service n'a pas de quota">
        <option value="auto" ${sim.coverPrefer==='auto'?'selected':''}>Auto — IGN (France) / OpenStreetMap</option>
        <option value="osm" ${sim.coverPrefer==='osm'?'selected':''}>OpenStreetMap uniquement</option>
      </select>`:''}
      <div class="statusline" id="coverStatus">${ui.geo.coverStatus}</div>
    </div>
    ${sim.coverEnabled?`
    <div class="field-row">
      <div class="field"><label>Hauteur arbres (m)</label><input type="number" id="treeH" min="0" max="50" step="1" value="${sim.clutterCfg.treeH}"></div>
      <div class="field"><label>Hauteur bâti (m)</label><input type="number" id="builtH" min="0" max="80" step="1" value="${sim.clutterCfg.builtH}"></div>
    </div>`:''}
    <div class="field"><label>Courbure terrestre (facteur k)</label>
      <select id="kSel">${[[4/3,'k = 4/3 (atmosphère standard)'],[1,'k = 1 (sans réfraction)'],[2/3,'k = 2/3 (sous-réfraction)']].map(([v,l])=>`<option value="${v}" ${Math.abs(v-sim.kFactor)<1e-6?'selected':''}>${l}</option>`).join('')}</select></div>
    <div class="hint">Pris en compte pour chaque liaison : relief réel (crêtes, collines et plateaux), courbure terrestre, réflexion sol, arbres et bâti (ITU-R P.2108 au pied des antennes, P.833 en traversée). L'antenne est posée sur le <b>sol</b> du modèle de relief, la hauteur saisie s'y ajoute ; arbres et bâti sont comptés à part. <span id="demBiasHint">${demBiasText()}</span> Détail par liaison : Maj+clic sur deux nœuds.</div>
    <div class="hint">Relief et végétation ne sont téléchargés que <b style="color:var(--text-0)">autour des nœuds</b> (le rectangle coloré sur la carte), pas pour toute la carte : c'est tout ce dont les calculs de liaison ont besoin. Ils se rechargent seuls quand vous placez ou déplacez des nœuds ailleurs.</div>
  `) +
  section('traffic','Trafic', `
    <div class="chiprow">
      ${Object.entries(TRAFFIC_PRESETS).map(([k,v])=>`<div class="chip ${sim.traffic.mode===k?'active':''}" data-tf="${k}">${v.label}</div>`).join('')}
      <div class="chip ${sim.traffic.mode==='custom'?'active':''}" data-tf="custom">Perso</div>
    </div>
    ${sim.traffic.mode==='custom'?`<div class="field" style="margin-top:8px"><label>Temps entre deux messages <span class="val">${fmtInterval(sim.traffic.msgPerHour()?3600/sim.traffic.msgPerHour():Infinity)}</span></label><input type="range" id="cMsg" min="0" max="${MSG_INTERVALS.length-1}" step="1" value="${intervalIdxFromTraffic()}"></div>`:''}
    <div class="hint">Messages humains : <b style="color:var(--text-0)">${sim.traffic.msgPerHour() ? `un toutes les ${fmtInterval(3600/sim.traffic.msgPerHour())} par ${sim.protocol==='meshcore'?'companion':'client'}` : 'aucun'}</b> en moyenne (processus de Poisson, 50 % directs / 50 % canal). Aussi réglable avec le curseur « Envois » sous la vitesse.</div>
    <div class="btnrow"><div class="mbtn toggle ${sim.traffic.background?'active':''}" id="bgToggle">${sim.traffic.background?'● Trafic protocolaire de fond':'○ Trafic protocolaire de fond'}</div></div>
    <div class="hint">${sim.protocol==='meshtastic'
      ? `NodeInfo / 3 h, position et télémétrie / 1 h (routers : 12 h)${sim.nodes.length>40?`, ×${fmt(sim.traffic.mtScaling(),2)} au-delà de 40 nœuds`:''} ${FID.badge('proto')}`
      : `Repeaters / room servers : advert flood toutes les ${sim.cfg.mcFloodAdvertH} h${sim.cfg.mcLocalAdvertMin?`, zero-hop toutes les ${sim.cfg.mcLocalAdvertMin} min`:''} ${FID.badge('proto')}`}. Phases aléatoires : pas d'émissions synchronisées.</div>
    ${sim.protocol==='meshcore'?`<div class="field" style="margin-top:6px"><label>Advert zero-hop des repeaters</label>
      <select id="mcLocalAdv">${[[0,'Désactivé (repeater configuré)'],[2,'2 min (repeater neuf, jamais configuré)'],[60,'60 min'],[240,'240 min']].map(([v,l])=>`<option value="${v}" ${v===sim.cfg.mcLocalAdvertMin?'selected':''}>${l}</option>`).join('')}</select></div>`:''}
    ${sim.protocol==='meshtastic'?`
      <div class="field" style="margin-top:8px"><label>Hop limit <span class="val">${sim.cfg.hopLimit}</span></label><input type="range" id="hopLimitRange" min="0" max="7" step="1" value="${sim.cfg.hopLimit}"></div>`
    :`
      <div class="field" style="margin-top:8px"><label>flood.max (sauts) <span class="val">${sim.cfg.mcFloodMax}</span></label><input type="range" id="floodMaxRange" min="1" max="64" step="1" value="${sim.cfg.mcFloodMax}"></div>
      <label class="check"><input type="checkbox" id="roomFwdChk" ${sim.cfg.mcRoomServerForward?'checked':''}> Room servers relaient (disable_fwd = 0)</label>`}
    <div class="subhead">Accusés de réception (ACK)</div>
    ${sim.protocol==='meshtastic'?`
      <label class="check"><input type="checkbox" id="ackChk" ${sim.cfg.mtAckEnabled?'checked':''}> Demander un ACK pour les messages texte</label>
      <label class="check ${sim.cfg.mtAckEnabled?'':'off'}"><input type="checkbox" id="retxChk" ${sim.cfg.retxEnabled?'checked':''} ${sim.cfg.mtAckEnabled?'':'disabled'}> Renvoyer si l'ACK n'arrive pas</label>
      <div class="hint">${sim.cfg.mtAckEnabled
        ? (sim.cfg.retxEnabled ? `Jusqu'à 2 renvois (3 envois au total, firmware). L'émetteur s'arrête dès qu'il reçoit l'ACK, ou dès qu'il entend un voisin relayer son message (ACK implicite). Attente ≈ ${fmt(mtAckWaitS(),1)} s ${FID.badge('proto')}` : `L'ACK est envoyé et compté, mais un message perdu n'est jamais renvoyé.`)
        : `Sans ACK, l'émetteur ne sait jamais si son message est arrivé : aucun renvoi possible.`}</div>`
    :`
      <label class="check"><input type="checkbox" id="retxChk" ${sim.cfg.retxEnabled?'checked':''}> Renvoyer si l'ACK n'arrive pas</label>
      ${sim.cfg.retxEnabled?`<div class="field" style="margin-top:4px"><label>Essais par message <span class="val">${sim.cfg.mcMaxAttempts}</span></label><input type="range" id="mcAttemptsRange" min="1" max="5" step="1" value="${sim.cfg.mcMaxAttempts}"></div>`:''}
      <div class="hint">L'ACK des messages directs est toujours envoyé (dans le retour de chemin, puis par le chemin appris). ${sim.cfg.retxEnabled
        ? `Chaque essai est un nouveau paquet. Si tous les essais par le chemin appris échouent, il est oublié et un dernier essai part en flood. Nombre d'essais fixé par l'application ${FID.badge('est')}`
        : `Sans renvoi, un chemin appris est oublié après ${sim.cfg.mcPathFailMax} messages perdus.`}</div>`}
  `) +
  section('advanced','Paramètres avancés', `
    <div class="field-row">
      <div class="field"><label>Seuil de capture (dB)</label><input type="number" id="capIn" min="0" max="20" step="0.5" value="${sim.cfg.captureDb}"></div>
      <div class="field"><label>Évanouissement σ (dB)</label><input type="number" id="fadeIn" min="0" max="12" step="0.5" value="${sim.cfg.fadingSigmaDb}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Facteur de bruit (dB)</label><input type="number" id="nfIn" min="1" max="15" step="0.5" value="${sim.cfg.noiseFigureDb}"></div>
      <div class="field"><label>Préambule (symb.)</label><input type="number" id="preIn" min="6" max="32" step="1" value="${sim.cfg.preambleSym}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>File TX max</label><input type="number" id="qIn" min="1" max="64" step="1" value="${sim.cfg.queueMax}"></div>
      <div class="field"><label>Portée max calcul (km)</label><input type="number" id="maxKmIn" min="1" max="300" step="1" value="${sim.cfg.maxLinkKm}"></div>
    </div>
    <div class="hint">Capture : une copie survit si elle dépasse la somme des interférences d'au moins ce seuil. σ : variation aléatoire du signal à chaque paquet (les liaisons en limite de sensibilité deviennent intermittentes).</div>
  `) +
  section('scenarios','Scénarios', `
    <div class="btnrow" style="flex-direction:column">
      <div class="mbtn" data-scn="village">🏘 Petit village — 20 nœuds</div>
      <div class="mbtn" data-scn="town">🏙 Ville — 100 nœuds</div>
      <div class="mbtn" data-scn="dept">🗺 Département — 500 nœuds</div>
      <div class="mbtn" data-scn="crisis" style="color:var(--red)">🚨 Simuler une crise (60 msg/h par client)</div>
    </div>
    <div class="hint">Les scénarios placent les nœuds autour du centre de la carte ; relief et occupation du sol sont chargés automatiquement.</div>
  `);
  wireLeftPanel();
  updateRangeEstimate();
  updateIntervalUI();
}

function wireLeftPanel(){
  $all('.section-h').forEach(h=>h.addEventListener('click',()=>{
    const s=h.parentElement; s.classList.toggle('closed');
    if(s.classList.contains('closed')) ui.closed.add(s.dataset.sec); else ui.closed.delete(s.dataset.sec);
  }));
  $all('[data-add]').forEach(b=>b.addEventListener('click',()=>{
    ui.addNodeMode = ui.addNodeMode===b.dataset.add ? null : b.dataset.add;
    if(ui.addNodeMode){ ui.send.on=false; ui.send.src=null; }
    renderLeftPanel(); updateModeHint(); highlightSelection();
  }));
  $('#autoNameChk').addEventListener('change',e=>{
    ui.autoName=e.target.checked;
    if(ui.autoName){ afterTopologyChange(); applyAutoNames(); }
    renderLeftPanel();
  });
  $('#btnRename')?.addEventListener('click',()=>{
    if(!sim.communes.pts.length) return toast('Les communes ne sont pas encore chargées : placez des nœuds en France et patientez quelques secondes.', true);
    const manuels=sim.nodes.filter(n=>!n.autoLabel).length;
    if(manuels && !confirm(`Renommer les ${sim.nodes.length} nœuds d'après leur commune ? ${manuels} nom(s) saisis à la main seront remplacés.`)) return;
    const n=applyAutoNames(true);
    toast(`${n} nœud(s) renommés d'après leur commune.`);
  });
  $all('[data-defh]').forEach(inp=>inp.addEventListener('change',()=>{
    const v=parseFloat(inp.value); if(!Number.isNaN(v)) DEFAULT_NODE_PROFILES[inp.dataset.defh].heightM=clamp(v,0,300);
    updateRangeEstimate();
  }));
  $('#btnApplyDefH').addEventListener('click',()=>{
    sim.nodes.forEach(n=>{ const h=DEFAULT_NODE_PROFILES[n.role].heightM; if(n.heightM!==h){ n.heightM=h; sim.nodeMoved(n); } });
    afterTopologyChange(); renderRightPanel();
    toast('Hauteurs d’antenne appliquées à tous les nœuds : les liaisons sont recalculées.');
  });
  $('#randCount').addEventListener('input',e=>$('#randCountLbl').textContent=e.target.value);
  $('#btnGenGrid').addEventListener('click',genGrid);
  $('#btnGenRandom').addEventListener('click',()=>genRandom(parseInt($('#randCount').value)||30));
  $('#btnClearNodes').addEventListener('click',()=>{
    // depuis que le réseau est enregistré automatiquement, un clic de trop est définitif
    if(sim.nodes.length>2 && !confirm(`Effacer les ${sim.nodes.length} nœuds de la carte ? L'enregistrement automatique de ce navigateur suivra. Les réseaux nommés de « Mes réseaux » ne sont pas touchés.`)) return;
    clearAllNodes(); renderLeftPanel();
  });
  wsWireSection();

  // envoi manuel
  $('#btnSendMode').addEventListener('click',()=>{
    ui.send.on=!ui.send.on; ui.send.src=null;
    if(ui.send.on){ ui.addNodeMode=null; toast('Mode envoi manuel actif : cliquez sur un nœud pour qu’il émette. Le déplacement par glisser reste possible.'); }
    renderLeftPanel(); updateModeHint(); highlightSelection();
  });
  $all('[data-sendtype]').forEach(c=>c.addEventListener('click',()=>{ ui.send.type=c.dataset.sendtype; ui.send.src=null; renderLeftPanel(); updateModeHint(); highlightSelection(); }));
  $('#sendSize').addEventListener('input',e=>{ ui.send.size=parseInt(e.target.value); $('#sendSizeLbl').textContent=ui.send.size+' o'; });
  $('#btnQuiet').addEventListener('click',()=>{ sim.traffic.mode='off'; sim.traffic.background=false; sim.traffic.invalidate(); renderLeftPanel(); toast('Trafic automatique coupé : seuls vos paquets manuels (et leurs ACK / retours de chemin) circulent.'); });

  // radio
  $('#presetSel').addEventListener('change',e=>applyPreset(e.target.value,true));
  $('#freqIn').addEventListener('change',e=>{ const v=parseFloat(e.target.value); if(v>100){ sim.radioCfg.freqMHz=v; sim.radioCfg.preset='custom'; sim.radioChanged(); renderLeftPanel(); } });
  $('#sfSel').addEventListener('change',e=>{ sim.radioCfg.sf=parseInt(e.target.value); sim.radioCfg.preset='custom'; sim.radioChanged(); renderLeftPanel(); });
  $('#bwSel').addEventListener('change',e=>{ sim.radioCfg.bwKHz=parseFloat(e.target.value); sim.radioCfg.preset='custom'; sim.radioChanged(); renderLeftPanel(); });
  $('#crSel').addEventListener('change',e=>{ sim.radioCfg.cr=parseInt(e.target.value); sim.radioCfg.preset='custom'; renderLeftPanel(); });
  $('#regSel').addEventListener('change',e=>{ sim.regProfile=e.target.value; renderLeftPanel(); renderMapOverlay(); });

  // terrain
  $all('[data-dem]').forEach(c=>c.addEventListener('click',()=>{
    sim.demMode=c.dataset.dem; sim.envChanged(); updateDemStatus(); afterTopologyChange(); renderLeftPanel(); renderRightPanel();
  }));
  $('#demPrefer')?.addEventListener('change',e=>{
    sim.demPrefer=e.target.value; sim.envChanged(); afterTopologyChange(); renderLeftPanel(); renderRightPanel();
  });
  $('#roughRange')?.addEventListener('change',e=>{ sim.syntheticDem.roughness=parseFloat(e.target.value); sim.syntheticDem.version++; sim.envChanged(); renderLeftPanel(); });
  $('#ampRange')?.addEventListener('change',e=>{ sim.syntheticDem.amplitude=parseFloat(e.target.value); sim.syntheticDem.version++; sim.envChanged(); renderLeftPanel(); });
  $('#coverToggle').addEventListener('click',()=>{
    sim.coverEnabled=!sim.coverEnabled; ui.geo.coverFailed=false; ui.geo.coverRetryS=0; clearTimeout(ui.geo.coverRetryTimer);
    sim.envChanged(); drawCoverOverlay(); updateCoverStatus(); afterTopologyChange(); renderLeftPanel();
  });
  $('#coverReload')?.addEventListener('click',()=>{ ui.geo.coverFailed=false; ui.geo.coverRetryS=0; clearTimeout(ui.geo.coverRetryTimer); ui.geo.forceCover=true; afterTopologyChange(); });
  $('#coverPrefer')?.addEventListener('change',e=>{
    sim.coverPrefer=e.target.value;
    sim.ignCover.downUntil=0;                 // un choix explicite annule la mise en retrait
    ui.geo.coverFailed=false; ui.geo.coverRetryS=0; clearTimeout(ui.geo.coverRetryTimer);
    ui.geo.forceCover=true; afterTopologyChange(); renderLeftPanel();
  });
  $('#treeH')?.addEventListener('change',e=>{ sim.clutterCfg.treeH=clamp(parseFloat(e.target.value)||0,0,50); sim.envChanged(); });
  $('#builtH')?.addEventListener('change',e=>{ sim.clutterCfg.builtH=clamp(parseFloat(e.target.value)||0,0,80); sim.envChanged(); });
  $('#kSel').addEventListener('change',e=>{ sim.kFactor=parseFloat(e.target.value); sim.envChanged(); });

  // trafic
  $all('[data-tf]').forEach(c=>c.addEventListener('click',()=>{ sim.traffic.mode=c.dataset.tf; sim.traffic.invalidate(); renderLeftPanel(); }));
  $('#cMsg')?.addEventListener('input',e=>{ setMsgInterval(parseInt(e.target.value)); e.target.previousElementSibling.querySelector('.val').textContent=fmtInterval(MSG_INTERVALS[parseInt(e.target.value)]); updateIntervalUI(); });
  $('#cMsg')?.addEventListener('change',()=>renderLeftPanel());
  $('#bgToggle').addEventListener('click',()=>{ sim.traffic.background=!sim.traffic.background; sim.traffic.invalidate(); renderLeftPanel(); });
  $('#hopLimitRange')?.addEventListener('input',e=>{ sim.cfg.hopLimit=parseInt(e.target.value); e.target.previousElementSibling.querySelector('.val').textContent=e.target.value; });
  $('#ackChk')?.addEventListener('change',e=>{ sim.cfg.mtAckEnabled=e.target.checked; renderLeftPanel(); });
  $('#retxChk')?.addEventListener('change',e=>{
    sim.cfg.retxEnabled=e.target.checked; renderLeftPanel(); renderMapOverlay();
    toast(sim.cfg.retxEnabled
      ? "Renvois activés : un émetteur sans ACK renvoie son message. Livraison plus fiable, mais plus de trafic quand le réseau sature — comparez le compteur « Renvois » avec l'option coupée."
      : "Renvois désactivés : les ACK circulent toujours, mais un message perdu n'est plus renvoyé.");
  });
  $('#mcAttemptsRange')?.addEventListener('input',e=>{ sim.cfg.mcMaxAttempts=parseInt(e.target.value); e.target.previousElementSibling.querySelector('.val').textContent=e.target.value; });
  $('#floodMaxRange')?.addEventListener('input',e=>{ sim.cfg.mcFloodMax=parseInt(e.target.value); e.target.previousElementSibling.querySelector('.val').textContent=e.target.value; });
  $('#roomFwdChk')?.addEventListener('change',e=>{ sim.cfg.mcRoomServerForward=e.target.checked; });
  $('#mcLocalAdv')?.addEventListener('change',e=>{ sim.cfg.mcLocalAdvertMin=parseInt(e.target.value); sim.traffic.invalidate(); renderLeftPanel(); });

  // avancé
  const num=(id,key,after)=>$('#'+id)?.addEventListener('change',e=>{ const v=parseFloat(e.target.value); if(!Number.isNaN(v)){ sim.cfg[key]=v; after&&after(); } });
  num('capIn','captureDb'); num('fadeIn','fadingSigmaDb',()=>sim.radioChanged()); num('nfIn','noiseFigureDb',()=>{ sim.radioChanged(); renderLeftPanel(); });
  num('preIn','preambleSym',()=>renderLeftPanel()); num('qIn','queueMax'); num('maxKmIn','maxLinkKm',()=>sim.radioChanged());

  $all('[data-scn]').forEach(b=>b.addEventListener('click',()=>runScenario(b.dataset.scn)));
}

// attente d'ACK Meshtastic pour un message de 60 o sur un canal peu occupé (RadioInterface::getRetransmissionMsec)
function mtAckWaitS(){
  const air=sim.airtime(60+16);
  return (2*air + (Math.pow(2,3) + 2*8 + Math.pow(2,5))*sim.slotMs() + 4500)/1000;
}

function applyPreset(key, rerender){
  const pr=MODEM_PRESETS[key]; sim.radioCfg.preset=key;
  if(pr && pr.sf){ Object.assign(sim.radioCfg,{sf:pr.sf, bwKHz:pr.bw, cr:pr.cr, freqMHz:pr.freq}); }
  sim.radioChanged();
  if(rerender) renderLeftPanel();
}

// portée sur terre plate sans obstacle, par recherche dichotomique sur la marge de liaison — [Estimation]
function flatRangeKm(roleA, roleB){
  const A=DEFAULT_NODE_PROFILES[roleA], B=DEFAULT_NODE_PROFILES[roleB];
  const env={dem:null, cover:null, freqMHz:sim.radioCfg.freqMHz, kFactor:sim.kFactor, clutter:{enabled:false}, stepM:200};
  const sens=sim.sensitivity(), a={lat:0,lng:0,heightM:A.heightM};
  const margin=km=>{ const b={...Geo.destPoint(0,0,90,km*1000), heightM:B.heightM}; return A.txPowerDbm+A.antGainDbi+B.antGainDbi-Propagation.pathLoss(a,b,env).totalDb-sens; };
  let lo=0.01, hi=300;
  if(margin(hi)>=0) return hi;
  for(let i=0;i<32;i++){ const mid=Math.sqrt(lo*hi); if(margin(mid)>=0) lo=mid; else hi=mid; }
  return lo;
}
function updateRangeEstimate(){
  const el=$('#rangeEstimate'); if(!el) return;
  const D=DEFAULT_NODE_PROFILES;
  el.innerHTML=`Portée max sur terrain plat dégagé ${FID.badge('est')} : client↔client (${D.client.heightM} m) <b style="color:var(--text-0)">${fmt(flatRangeKm('client','client'),1)} km</b> · repeater↔repeater (${D.repeater.heightM} m) <b style="color:var(--text-0)">${fmt(flatRangeKm('repeater','repeater'),1)} km</b>. Relief, arbres et bâti la réduisent fortement.`;
}


/* ---------------- nommage d'après la commune ----------------
   Un nom de nœud tient en six caractères et se lit d'un coup d'œil dans le
   tableau des liaisons : une lettre de rôle, un tiret, les quatre premières
   lettres de la commune la plus proche. « R-ANDE », c'est le répéteur des
   Andelys ; « C-GAIL », un client à Gaillon.

   Les lettres valent dans les deux protocoles, pour qu'un réseau enregistré
   garde son sens quand on bascule de Meshtastic à MeshCore :
     R  repeater                    — le relais qu'on installe exprès
     N  router / room server        — nœud fixe d'infrastructure
     C  client / companion          — le poste d'un utilisateur
   Deux nœuds de même rôle dans la même commune sont numérotés (C-GAIL, C-GAIL2).
   Un nom saisi à la main n'est jamais réécrit. */
const ROLE_LETTER = {repeater:'R', router:'N', client:'C'};
function autoNameOf(n){
  const c = sim.communes.nearest(n.lat, n.lng);
  return c ? (ROLE_LETTER[n.role]||'N') + '-' + c.abbr : null;
}
function applyAutoNames(force){
  if(!sim.communes.pts.length) return 0;
  const nodes=[...sim.nodes].sort((a,b)=>a.id-b.id);   // ordre stable : les numéros ne dansent pas
  const taken=new Set();
  if(!force) for(const n of nodes) if(!n.autoLabel) taken.add(n.label);
  let changed=0;
  for(const n of nodes){
    if(!force && !n.autoLabel) continue;
    const base=autoNameOf(n); if(!base) continue;
    let name=base, k=1;
    while(taken.has(name)) name=base+(++k);
    taken.add(name);
    if(n.label!==name){ n.label=name; changed++; }
    n.autoLabel=true;
  }
  if(changed){
    // le nom n'est pas dans l'icône (l'infobulle se recalcule au survol) : seules
    // les listes qui l'affichent ont besoin d'être redessinées
    renderLogList(true);
    if((ui.bottomTab||'log')==='links'){ ui.linksTableSig=null; renderLinksTable(true); }
    if(ui.selectedA) renderRightPanel();
  }
  return changed;
}

/* ---------------- génération ---------------- */
function clearAllNodes(){
  sim.clearNodes(); ui.layers.nodes.clearLayers(); ui.markers.clear(); ui.layers.path.clearLayers();
  ui.selectedA=ui.selectedB=null; ui.selectedPacket=null; ui.send.src=null; ui.pickDestFor=null;
  renderRightPanel(); renderMapOverlay(); renderLogList(true);
}
function genGrid(){
  const N=clamp(parseInt($('#gridN').value)||5,2,20), spacing=parseFloat($('#gridSpacing').value)||900;
  const c=ui.map.getCenter();
  clearAllNodes();
  for(let i=0;i<N;i++) for(let j=0;j<N;j++){
    let p=Geo.destPoint(c.lat,c.lng,0,(i-(N-1)/2)*spacing);
    p=Geo.destPoint(p.lat,p.lng,90,(j-(N-1)/2)*spacing);
    drawNode(sim.addNode(p.lat,p.lng,{role:(i%4===0&&j%4===0)?'repeater':'client'}));
  }
  afterTopologyChange();
  toast(`Grille ${N}×${N} (${N*N} nœuds), espacement ${spacing} m. Relief et occupation du sol en cours de chargement.`);
}
function genRandom(count){
  const c=ui.map.getCenter(), radiusM=Math.max(800, Math.sqrt(count)*350);
  clearAllNodes();
  for(let i=0;i<count;i++){
    const p=Geo.destPoint(c.lat,c.lng,Math.random()*360,Math.sqrt(Math.random())*radiusM);
    drawNode(sim.addNode(p.lat,p.lng,{role:Math.random()<0.1?'repeater':'client'}));
  }
  afterTopologyChange();
  toast(`${count} nœuds générés dans un rayon de ${fmtDist(radiusM)} (10 % de repeaters).`);
}
function runScenario(name){
  const presets={village:[20,'normal','Petit village'], town:[100,'normal','Ville'], dept:[500,'calm','Département']};
  if(presets[name]){
    const [n,mode,label]=presets[name];
    genRandom(n); sim.traffic.mode=mode; sim.traffic.invalidate(); renderLeftPanel();
    toast(`Scénario « ${label} » : ${n} nœuds, trafic ${TRAFFIC_PRESETS[mode].label.toLowerCase()}.`);
  } else if(name==='crisis'){
    sim.traffic.mode='crisis'; sim.traffic.invalidate(); renderLeftPanel();
    toast('🚨 Crise : 60 messages/heure par client. Observez la montée des collisions et des files d’attente dans le Dashboard.');
    if(!ui.playing) togglePlay();
  }
}

/* ---------------- inspecteur (panneau droit) ---------------- */
function renderRightPanel(mode){
  const el=$('#rightPanel');
  if(ui.selectedPacket) return renderPacketInspector(ui.selectedPacket, true);
  applyPacketHighlight(null); ui.pktSig=null;
  if((mode==='link' || ui.selectedB) && ui.selectedA && ui.selectedB) return renderLinkInspector(ui.selectedA, ui.selectedB);
  if(ui.selectedA && sim.nodeById(ui.selectedA)) return renderNodeInspector(ui.selectedA);
  ui.selectedA=null;
  el.innerHTML=`<div class="insp-empty">Sélectionnez un nœud pour régler son antenne ou émettre un paquet.<br><br>Maj+clic sur un 2ᵉ nœud : bilan de liaison et profil du terrain.<br><br>Cliquez une ligne du journal pour suivre un paquet.</div>`;
}

function renderNodeInspector(id){
  const n=sim.nodeById(id), el=$('#rightPanel'); if(!n) return;
  const dem=sim.activeDem(), cover=sim.activeCover();
  const ground = dem ? dem.elevation(n.lat,n.lng) : 0;
  const cls = cover ? cover.classAt(n.lat,n.lng) : COVER_NONE;
  const R = cls===COVER_TREES ? sim.clutterCfg.treeH : cls===COVER_BUILT ? sim.clutterCfg.builtH : 0;
  const termLoss = (sim.clutterCfg.enabled && cover) ? Propagation.terminalClutterLoss(n.heightM, R, sim.radioCfg.freqMHz) : 0;
  const commune = sim.communes.pts.length ? sim.communes.nearest(n.lat, n.lng) : null;
  const prof=REG_PROFILES[sim.regProfile], erp=RadioModel.erpDbm(n);
  const demSrc = sim.demMode==='real' ? FID.badge('phys')+' '+demSourceLabel(sim.realDem) : sim.demMode==='synthetic' ? FID.badge('est')+' synthétique' : '(relief ignoré)';
  el.innerHTML=`
    <div class="insp-title"><input class="name-in" id="nLabel" value="${esc(n.label)}" maxlength="24" title="Videz le champ pour revenir au nom automatique"><div class="type">${roleLabel(n.role)} · #${n.id}${commune?` · ${esc(commune.nom)}`:''}</div></div>
    <div class="insp-body">
      <h3 class="ih">Antenne & radio</h3>
      <div class="form2">
        <label>Rôle<select id="nRole">${['client','router','repeater'].map(r=>`<option value="${r}" ${r===n.role?'selected':''}>${roleLabel(r)}</option>`).join('')}</select></label>
        <label>Hauteur antenne (m)<input type="number" id="nHeight" min="0" max="300" step="0.5" value="${n.heightM}"></label>
        <label>Puissance TX (dBm)<input type="number" id="nPower" min="0" max="30" step="1" value="${n.txPowerDbm}"></label>
        <label>Gain antenne (dBi)<input type="number" id="nGain" min="-5" max="15" step="0.5" value="${n.antGainDbi}"></label>
      </div>
      <label class="check"><input type="checkbox" id="nActive" ${n.active?'checked':''}> Nœud actif</label>
      ${prof.maxErpDbm!=null?`<div class="kv"><span class="k">ERP ${FID.badge('reg')}</span><span class="v ${erp>prof.maxErpDbm?'red':'green'}">${fmt(erp,1)} / ${prof.maxErpDbm} dBm</span></div>`:''}

      <h3 class="ih">Environnement</h3>
      <div class="kv"><span class="k">Altitude du sol</span><span class="v">${Number.isNaN(ground)?'<span class="amber">tuile non chargée</span>':fmt(ground,0)+' m'} <small>${demSrc}</small></span></div>
      <div class="kv"><span class="k">Antenne (altitude)</span><span class="v">${Number.isNaN(ground)?'–':fmt(ground+n.heightM,0)+' m'}</span></div>
      <div class="kv"><span class="k">Occupation du sol</span><span class="v">${cover?coverLabel(cls):'<small>non chargée</small>'}</span></div>
      ${cover&&R?`<div class="kv"><span class="k">Perte clutter au pied ${FID.badge('est')}</span><span class="v ${termLoss>0?'amber':'green'}">${fmt(termLoss,1)} dB</span></div>
      <div class="hint">${n.heightM>=R?`Antenne au-dessus du clutter local (${R} m) : pas de perte.`:`Antenne sous le clutter local (${R} m) : ITU-R P.2108. Montez-la au-dessus de ${R} m pour supprimer cette perte.`}</div>`:''}

      <h3 class="ih">Émettre depuis ce nœud</h3>
      <div class="btnrow">
        <div class="mbtn" data-nsend="BROADCAST">📡 Canal</div>
        <div class="mbtn ${ui.pickDestFor===n.id?'active':''}" data-nsend="MESSAGE">✉ Direct…</div>
        <div class="mbtn" data-nsend="ADVERT">${sim.protocol==='meshcore'?'📣 Advert':'📣 NodeInfo'}</div>
      </div>
      <div id="inspLive"></div>
    </div>
    <div class="insp-actions">
      <div class="mbtn" id="btnFocusNode">Centrer</div>
      <div class="mbtn" id="btnDelNode" style="color:var(--red)">Supprimer</div>
    </div>`;
  const applyGeo = ()=>{ sim.nodeMoved(n); afterTopologyChange(); renderNodeInspectorLive(n); };
  $('#nLabel').addEventListener('change',e=>{
    const v=e.target.value.trim();
    n.autoLabel = !v;                       // champ vidé : le nom automatique reprend la main
    n.label = v || (autoNameOf(n) || ('N'+n.id));
    e.target.value = n.label;
    refreshMarker(n); renderLogList(true);
    if((ui.bottomTab||'log')==='links'){ ui.linksTableSig=null; renderLinksTable(true); }
  });
  $('#nRole').addEventListener('change',e=>{
    n.role=e.target.value; sim.nodeParamsChanged();
    if(ui.autoName) applyAutoNames();          // la lettre du nom suit le rôle
    refreshMarker(n); renderRightPanel();
  });
  $('#nHeight').addEventListener('change',e=>{ const v=parseFloat(e.target.value); if(!Number.isNaN(v)){ n.heightM=clamp(v,0,300); applyGeo(); renderRightPanel(); } });
  $('#nPower').addEventListener('change',e=>{ const v=parseFloat(e.target.value); if(!Number.isNaN(v)){ n.txPowerDbm=clamp(v,0,30); sim.nodeParamsChanged(); renderRightPanel(); renderLeftPanel(); } });
  $('#nGain').addEventListener('change',e=>{ const v=parseFloat(e.target.value); if(!Number.isNaN(v)){ n.antGainDbi=clamp(v,-5,15); sim.nodeParamsChanged(); renderRightPanel(); renderLeftPanel(); } });
  $('#nActive').addEventListener('change',e=>{ sim.setActive(n, e.target.checked); refreshMarker(n); renderMapOverlay(); });
  $all('[data-nsend]').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.nsend;
    if(k==='MESSAGE'){ ui.pickDestFor = ui.pickDestFor===n.id ? null : n.id; ui.addNodeMode=null; updateModeHint(); highlightSelection(); b.classList.toggle('active', ui.pickDestFor===n.id); return; }
    manualSend(n, null, sendTypeFor(k));
  }));
  $('#btnFocusNode').addEventListener('click',()=>ui.map.panTo([n.lat,n.lng]));
  $('#btnDelNode').addEventListener('click',()=>{ sim.removeNode(n.id); removeMarker(n.id); ui.selectedA=null; afterTopologyChange(); renderRightPanel(); });
  renderNodeInspectorLive(n);
}
function renderNodeInspectorLive(n){
  const box=$('#inspLive'); if(!box) return;
  const s=n.stats, prof=REG_PROFILES[sim.regProfile];
  let nb;
  if(sim.links.dirty) nb=`<div class="hint">⏳ Calcul des liaisons… ${Math.round(sim.links.progress*100)} %</div>`;
  else {
    const list=sim.links.neighbors(n).filter(x=>x.viable);
    nb = list.length ? list.slice(0,8).map(x=>`<div class="nbrow" data-nb="${x.node.id}"><span>${esc(x.node.label)} <small>${fmtDist(x.pl.distM)}</small></span><span class="${({good:'green',fair:'amber',none:'red'})[stateOfMargin(x.margin)]}">${fmt(x.rssi,0)} dBm · +${fmt(x.margin,0)} dB</span></div>`).join('')
      + (list.length>8?`<div class="hint">… et ${list.length-8} autre(s)</div>`:'')
      : `<div class="hint warn">Aucun voisin radio viable : ce nœud est isolé. Augmentez la hauteur d'antenne ou ajoutez un repeater.</div>`;
  }
  box.innerHTML=`
    <h3 class="ih">Voisins radio ${FID.badge('est')} <small>(${sim.links.dirty?'…':sim.links.neighbors(n).filter(x=>x.viable).length})</small></h3>
    ${nb}
    <h3 class="ih">Statistiques ${FID.badge('proto')}</h3>
    <div class="kv"><span class="k">Paquets créés</span><span class="v">${s.generated}</span></div>
    <div class="kv"><span class="k">Émissions (dont relais)</span><span class="v">${s.tx} <small>(${s.relayed})</small></span></div>
    <div class="kv"><span class="k">Reçus / doublons</span><span class="v">${s.rx} <small>/ ${s.dupes}</small></span></div>
    ${sim.protocol==='meshtastic'?`<div class="kv"><span class="k">Relais annulés (doublon)</span><span class="v">${s.suppressed}</span></div>`:''}
    <div class="kv" title="Paquets dont ce nœud était le destinataire final (messages, ACK, retours de chemin)"><span class="k">Reçus comme destinataire</span><span class="v green">${s.delivered}</span></div>
    <div class="kv" title="Paquets adressés que ce nœud a créés et qui ne sont jamais arrivés, tous types"><span class="k">Envoyés jamais arrivés</span><span class="v amber">${s.dropped}</span></div>
    ${ackActive()?`<div class="kv"><span class="k">Renvois (ACK manquant)</span><span class="v">${s.retx}</span></div>`:''}
    <div class="kv"><span class="k">Collisions / en émission</span><span class="v red">${s.collisions} <small>/ ${s.halfDuplex}</small></span></div>
    <div class="kv"><span class="k">Canal occupé avant TX</span><span class="v">${s.cadBusy}</span></div>
    <div class="kv"><span class="k">File d'attente</span><span class="v">${n.queue.length} <small>(max ${s.queueMax}, rejets ${s.queueDrops})</small></span></div>
    <div class="kv"><span class="k">Occupation canal perçue</span><span class="v">${fmt(sim.nodeUtilPct(n),1)} %</span></div>
    <div class="kv"><span class="k">Airtime cumulé</span><span class="v">${fmt(s.airtimeMs/1000,2)} s</span></div>
    ${prof.dutyCycle?`<div class="kv"><span class="k">Duty cycle 1 h ${FID.badge('reg')}</span><span class="v ${n.dutyState==='over'?'red':n.dutyState==='warn'?'amber':'green'}">${fmt(n.currentDutyPct*100,2)} % / ${prof.dutyCycle*100} %</span></div>`:''}`;
  $all('[data-nb]',box).forEach(r=>r.addEventListener('click',()=>{ ui.selectedB=parseInt(r.dataset.nb); ui.ign=null; renderRightPanel('link'); highlightSelection(); }));
}

function renderLinkInspector(idA, idB){
  const a=sim.nodeById(idA), b=sim.nodeById(idB), el=$('#rightPanel');
  if(!a||!b){ ui.selectedB=null; return renderRightPanel(); }
  const env=sim.propEnv();
  const useIgn = ui.ign && ui.ign.a===a.id && ui.ign.b===b.id && ui.ign.z;
  if(useIgn){ env.overrideProfile=ui.ign.z; env.dem=null; }
  const pl=Propagation.pathLoss(a,b,env,true);
  const sens=sim.sensitivity(), nf=sim.noiseFloor();
  const rAB=a.txPowerDbm+a.antGainDbi+b.antGainDbi-pl.totalDb, rBA=b.txPowerDbm+b.antGainDbi+a.antGainDbi-pl.totalDb;
  const mAB=rAB-sens, mBA=rBA-sens;
  const cls=m=>({good:'green', fair:'amber', none:'red'})[stateOfMargin(m)];
  const linkState=stateOfMargin(Math.min(mAB,mBA));
  const srtm = useIgn ? Propagation.pathLoss(a,b,sim.propEnv()) : null;
  el.innerHTML=`
    <div class="insp-title"><div class="name">${esc(a.label)} ↔ ${esc(b.label)}</div><div class="type">Bilan de liaison · ${fmtDist(pl.distM)}</div></div>
    <div class="insp-body">
      <div class="link-verdict ${LINK_STATE[linkState].cls}"><b>Liaison ${LINK_STATE[linkState].label}</b><span>${esc(b.label)} ${mAB>=0?'reçoit':'ne reçoit pas'} ${esc(a.label)} (${fmtMargin(mAB)}) · ${esc(a.label)} ${mBA>=0?'reçoit':'ne reçoit pas'} ${esc(b.label)} (${fmtMargin(mBA)})</span><span>${LINK_STATE[linkState].help}${linkState!=='good'?` · principale perte : ${linkCause({computed:true, pl, distM:pl.distM})}`:''}</span></div>
      <div class="kv"><span class="k">Perte espace libre ${FID.badge('phys')}</span><span class="v">${fmt(pl.fsplDb,1)} dB</span></div>
      <div class="kv"><span class="k">Obstacles du relief ${FID.badge('phys')}</span><span class="v ${pl.obstacleDb===pl.terrainDb&&pl.terrainDb>0?'':'dim'}">${fmt(pl.terrainDb,1)} dB</span></div>
      ${pl.terrainDb>0?`<div class="hint" style="margin:-2px 0 4px">Plus forte de deux estimations : crêtes fines (Deygout) ${fmt(pl.deygoutDb,1)} dB · colline ou plateau arrondi ${fmt(pl.bullingtonDb+pl.roundedDb,1)} dB${pl.roundedDb>0?` (dont ${fmt(pl.roundedDb,1)} dB dus à la largeur de l'obstacle, ${fmtDist(pl.horizonSpanM)} de large)`:''}.</div>`:''}
      <div class="kv"><span class="k">Réflexion sol (terre plane)</span><span class="v ${pl.obstacleDb===pl.groundDb&&pl.groundDb>0?'':'dim'}">${fmt(pl.groundDb,1)} dB</span></div>
      <div class="hint" style="margin:-2px 0 4px">Seule la plus forte des deux est comptée (${fmt(pl.obstacleDb,1)} dB). Hauteurs effectives : ${fmt(pl.hEffA,0)} m / ${fmt(pl.hEffB,0)} m.</div>
      <div class="kv"><span class="k">Arbres / bâti sur le trajet ${FID.badge('est')}</span><span class="v">${fmt(pl.clutterDb,1)} dB${pl.vegDepthM?` <small>(${Math.round(pl.vegDepthM)} m de végétation)</small>`:''}</span></div>
      <div class="kv"><span class="k">Clutter au pied de ${esc(a.label)} / ${esc(b.label)} ${FID.badge('est')}</span><span class="v">${fmt(pl.termADb,1)} / ${fmt(pl.termBDb,1)} dB</span></div>
      <div class="kv strong"><span class="k">Perte totale</span><span class="v">${fmt(pl.totalDb,1)} dB</span></div>
      <div class="kv"><span class="k">Ligne de visée (relief)</span><span class="v ${pl.blocked?'red':'green'}">${pl.blocked?'Obstruée':'Dégagée'}</span></div>
      <div class="kv"><span class="k">Dégagement 1ʳᵉ zone de Fresnel</span><span class="v ${pl.fresnelRatio>=0.6?'green':pl.fresnelRatio>0?'amber':'red'}">${fmt(clamp(pl.fresnelRatio,-9.9,9.9)*100,0)} %</span></div>
      <div class="kv"><span class="k">RSSI ${esc(a.label)}→${esc(b.label)}</span><span class="v ${cls(mAB)}">${fmt(rAB,1)} dBm · ${mAB>=0?'+':''}${fmt(mAB,1)} dB</span></div>
      <div class="kv"><span class="k">RSSI ${esc(b.label)}→${esc(a.label)}</span><span class="v ${cls(mBA)}">${fmt(rBA,1)} dBm · ${mBA>=0?'+':''}${fmt(mBA,1)} dB</span></div>
      <div class="kv"><span class="k">SNR (A→B) / sensibilité</span><span class="v">${fmt(rAB-nf,1)} dB / ${fmt(sens,1)} dBm</span></div>
      <h3 class="ih">Profil du trajet ${useIgn?'· IGN RGE ALTI 1 m':sim.demMode==='real'?'· '+demSourceLabel(sim.realDem):sim.demMode==='synthetic'?'· synthétique':'· plat'}</h3>
      <canvas id="elevCanvas" height="130"></canvas>
      <div class="profile-legend"><span><i style="background:#f0a742"></i>relief</span><span><i style="background:#3ecf8e"></i>arbres</span><span><i style="background:#e5555f"></i>bâti</span><span><i style="background:#49c8e8"></i>visée</span><span><i class="dash"></i>60 % Fresnel</span></div>
      <div class="kv"><span class="k">Sol A / B</span><span class="v">${fmt(pl.groundA,0)} m / ${fmt(pl.groundB,0)} m</span></div>
      ${pl.demMissing?'<div class="hint warn">⚠ Relief incomplet sur ce trajet (tuiles manquantes).</div>':''}
      <div class="btnrow"><div class="mbtn" id="btnIgn">${useIgn?'↺ Revenir au relief de la simulation':'🇫🇷 Profil haute précision IGN 1 m'}</div></div>
      ${useIgn?`<div class="hint">RGE ALTI 1 m (200 points interrogés à la demande) : relief ${fmt(pl.terrainDb,1)} dB contre ${fmt(srtm.terrainDb,1)} dB avec le relief ${demSourceLabel(sim.realDem)} de la simulation ; perte totale ${fmt(pl.totalDb,1)} dB contre ${fmt(srtm.totalDb,1)} dB. Cette comparaison ne change pas les liaisons simulées.</div>`:`<div class="hint" id="ignHint">Interroge l'API altimétrique de l'IGN (France uniquement, 200 points au pas du RGE ALTI 1 m) pour vérifier ce lien plus finement que les tuiles ${demSourceLabel(sim.realDem)}.</div>`}
    </div>
    <div class="insp-actions"><div class="mbtn" id="btnBackNode">← ${esc(a.label)}</div></div>`;
  requestAnimationFrame(()=>drawProfile($('#elevCanvas'), pl, a, b));
  $('#btnBackNode').addEventListener('click',()=>{ ui.selectedB=null; renderRightPanel('node'); highlightSelection(); });
  $('#btnIgn').addEventListener('click', async ()=>{
    if(useIgn){ ui.ign=null; return renderRightPanel('link'); }
    const hint=$('#ignHint'); if(hint) hint.textContent='Requête IGN en cours…';
    try{
      const z=await IgnAltimetry.profile(a,b,200);
      ui.ign={a:a.id, b:b.id, z}; renderRightPanel('link');
    }catch(err){ if(hint) hint.innerHTML=`<span style="color:var(--amber)">⚠ ${esc(err.message)}</span>`; }
  });
}
function drawProfile(cv, pl, a, b){
  if(!cv) return;
  const dpr=window.devicePixelRatio||1, Wc=cv.clientWidth||260, Hc=130;
  cv.width=Wc*dpr; cv.height=Hc*dpr;
  const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  const P=pl.profile, D=pl.distM||1, pad=8;
  let lo=Infinity, hi=-Infinity;
  P.forEach(p=>{ lo=Math.min(lo,p.g); hi=Math.max(hi,p.gc); });
  hi=Math.max(hi,pl.hA,pl.hB); lo=Math.min(lo,pl.hA,pl.hB);
  const span=Math.max(hi-lo, 20); hi=lo+span*1.12; lo-=span*0.04;
  const X=d=>pad+(Wc-2*pad)*d/D, Y=e=>Hc-pad-(Hc-2*pad)*(e-lo)/(hi-lo);
  ctx.clearRect(0,0,Wc,Hc);
  // clutter
  for(let i=0;i<P.length-1;i++){
    if(P[i].gc<=P[i].g+0.01) continue;
    ctx.fillStyle = P[i].cls===COVER_TREES ? 'rgba(62,207,142,.55)' : 'rgba(229,85,95,.5)';
    ctx.fillRect(X(P[i].d), Y(P[i].gc), Math.max(1,X(P[i+1].d)-X(P[i].d)), Y(P[i].g)-Y(P[i].gc));
  }
  // relief
  ctx.beginPath(); ctx.moveTo(X(0),Hc);
  P.forEach(p=>ctx.lineTo(X(p.d),Y(p.g)));
  ctx.lineTo(X(D),Hc); ctx.closePath();
  ctx.fillStyle='rgba(240,167,66,.22)'; ctx.fill();
  ctx.beginPath(); P.forEach((p,i)=>i?ctx.lineTo(X(p.d),Y(p.g)):ctx.moveTo(X(p.d),Y(p.g)));
  ctx.strokeStyle='#f0a742'; ctx.lineWidth=1.3; ctx.stroke();
  // 60 % de la 1re zone de Fresnel (bord inférieur)
  ctx.beginPath();
  P.forEach((p,i)=>{ const los=pl.hA+(pl.hB-pl.hA)*p.d/D; const r=0.6*Math.sqrt(pl.lambda*p.d*(D-p.d)/D); const y=Y(los-r); i?ctx.lineTo(X(p.d),y):ctx.moveTo(X(p.d),y); });
  ctx.strokeStyle='rgba(73,200,232,.55)'; ctx.setLineDash([3,3]); ctx.lineWidth=1; ctx.stroke(); ctx.setLineDash([]);
  // ligne de visée
  ctx.beginPath(); ctx.moveTo(X(0),Y(pl.hA)); ctx.lineTo(X(D),Y(pl.hB));
  ctx.strokeStyle='#49c8e8'; ctx.lineWidth=1.4; ctx.stroke();
  // mâts
  ctx.strokeStyle='#e8eef4'; ctx.lineWidth=2;
  [[0,pl.groundA,pl.hA],[D,pl.groundB,pl.hB]].forEach(([d,g,h])=>{ ctx.beginPath(); ctx.moveTo(X(d),Y(g)); ctx.lineTo(X(d),Y(h)); ctx.stroke(); });
  ctx.fillStyle='#49c8e8';
  [[0,pl.hA],[D,pl.hB]].forEach(([d,h])=>{ ctx.beginPath(); ctx.arc(X(d),Y(h),3,0,7); ctx.fill(); });
  ctx.fillStyle='#6d7f8f'; ctx.font='9px ui-monospace,monospace';
  ctx.fillText(`${Math.round(hi)} m`,pad+2,pad+8); ctx.fillText(`${Math.round(lo)} m`,pad+2,Hc-pad-2);
}

function ackRows(p){
  const tr=p.tracker;
  if(!tr) return ['ACK','PATH'].includes(p.type) ? '' : `<div class="kv"><span class="k">Accusé de réception</span><span class="v dim">non demandé</span></div>`;
  let state, cls='';
  if(p.ackReceived){ state='ACK reçu par l’émetteur'; cls='green'; }
  else if(tr.ackKind==='implicit'){ state='ACK implicite (relais entendu)'; cls='green'; }
  else if(tr.failed){ state='aucun ACK — échec'; cls='red'; }
  else if(!tr.done){ state='en attente…'; cls='amber'; }
  else { state='—'; }
  return `<div class="kv"><span class="k">Accusé de réception</span><span class="v ${cls}">${state}</span></div>
    <div class="kv"><span class="k">Envois de l’émetteur</span><span class="v">${tr.attempt}${tr.floodFallback?' (dernier en flood)':''} <small>/ ${tr.max}${tr.floodFallback?' + 1':''} max</small></span></div>`;
}
/* ---- qui a reçu le paquet sélectionné ? ---- */
const RX_WHY={collision:'collision', half_duplex:'occupé à émettre', weak:'signal trop faible'};
function relayText(r){
  if(!r) return '';
  if(r==='relayed') return 'a relayé';
  if(r==='planned') return 'relais programmé';
  if(r==='cancelled') return 'relais annulé (a entendu un voisin relayer avant lui)';
  if(r==='destinataire') return 'destinataire';
  if(r.startsWith('no:')) return 'ne relaie pas : '+(LOSS_LABEL[r.slice(3)]||r.slice(3));
  return r;
}
function classifyReception(p){
  const ok=[], lost=[], none=[];
  for(const n of sim.nodes){
    if(n.id===p.originId) continue;
    const d=p.detail && p.detail.get(n.id);
    if(d && d.st==='ok') ok.push([n,d]);
    else if(d && Object.keys(d.lost).length) lost.push([n,d]);
    else if(!p.detail && p.reached.has(n.id)) ok.push([n,null]);
    else none.push(n);
  }
  ok.sort((a,b)=>(a[1]?.t??0)-(b[1]?.t??0));
  return {ok, lost, none};
}
function applyPacketHighlight(p){
  const cls=['pk-ok','pk-relay','pk-lost','pk-none','pk-origin','pk-dest'];
  const {ok,lost}=p ? classifyReception(p) : {ok:[],lost:[]};
  const okIds=new Set(ok.map(([n])=>n.id)), lostIds=new Set(lost.map(([n])=>n.id));
  ui.markers.forEach((m,id)=>{
    const el=markerEl(id); if(!el) return;
    el.classList.remove(...cls);
    if(!p) return;
    if(id===p.originId) el.classList.add('pk-origin');
    else if(okIds.has(id)) el.classList.add(p.relayers.has(id)?'pk-relay':'pk-ok');
    else if(lostIds.has(id)) el.classList.add('pk-lost');
    else el.classList.add('pk-none');
    if(id===p.destId) el.classList.add('pk-dest');
  });
}
function receptionSection(p){
  const label=id=>esc(sim.nodeById(id)?.label||('#'+id));
  if(!p.detail) return `<h3 class="ih">Qui a reçu ce paquet ?</h3><div class="hint">Détail non conservé pour ce paquet ancien (gardé pour les 400 derniers paquets et tous les paquets manuels). Nœuds qui l'ont reçu : ${p.reached.size-1}.</div>`;
  const {ok,lost,none}=classifyReception(p);
  const lostBy={}; lost.forEach(([,d])=>Object.keys(d.lost).forEach(k=>lostBy[k]=(lostBy[k]||0)+1));
  const MAX=60;
  const okRows=ok.slice(0,MAX).map(([n,d])=>`<div class="rxrow" data-rxnode="${n.id}"><i class="st ${p.relayers.has(n.id)?'relay':'ok'}"></i><b>${label(n.id)}</b>
      <span>reçu à +${fmt((d.t-p.createdAt)/1000,2)} s de <b>${label(d.from)}</b> · ${d.hops?`${d.hops} relais avant`:'en direct'} · ${fmt(d.rssi,0)} dBm${d.dups?` · puis ${d.dups} doublon${d.dups>1?'s':''}`:''}${d.relay?`<em>${relayText(d.relay)}</em>`:''}</span></div>`).join('');
  const lostRows=lost.map(([n,d])=>`<div class="rxrow" data-rxnode="${n.id}"><i class="st lost"></i><b>${label(n.id)}</b>
      <span>à portée mais jamais décodé : ${Object.entries(d.lost).map(([k,v])=>`${RX_WHY[k]||k}${v>1?` ×${v}`:''}`).join(', ')}</span></div>`).join('');
  return `
    <h3 class="ih">Qui a reçu ce paquet ?</h3>
    <div class="rxsum">
      <span><i class="st ok"></i>reçu <b>${ok.length}</b></span>
      <span><i class="st lost"></i>perdu <b>${lost.length}</b></span>
      <span><i class="st none"></i>jamais atteint <b>${none.length}</b></span>
    </div>
    <div class="hint">Sur les ${sim.nodes.length-1} autres nœuds. Carte : <b class="green">vert</b> reçu, <b class="amber">orange</b> reçu et relayé, <b class="red">rouge</b> à portée mais perdu${Object.keys(lostBy).length?` (${Object.entries(lostBy).map(([k,v])=>`${RX_WHY[k]||k} : ${v}`).join(', ')})`:''}, estompé jamais atteint, cerclé blanc l'émetteur.</div>
    ${okRows}${ok.length>MAX?`<div class="hint">… et ${ok.length-MAX} autres nœuds ayant reçu</div>`:''}
    ${lostRows}
    ${none.length?`<div class="rxrow none"><i class="st none"></i><b>Jamais atteint</b><span>Aucune émission de ce paquet ne leur est parvenue avec un signal suffisant : ${none.slice(0,40).map(n=>label(n.id)).join(', ')}${none.length>40?` +${none.length-40}`:''}</span></div>`:''}`;
}
function txTimelineSection(p){
  if(!p.txLog || !p.txLog.length) return '';
  const label=id=>esc(sim.nodeById(id)?.label||('#'+id));
  const rows=p.txLog.slice(0,40).map(s=>`<div class="txrow"><span class="t">+${fmt((s.t-p.createdAt)/1000,2)} s</span>
    <span><b>${label(s.from)}</b> ${s.relay?'relaie':'émet'}${s.attempt>1?` (envoi ${s.attempt})`:''} → <span class="green">${s.ok.length} nouveau${s.ok.length>1?'x':''}</span>${s.lost.length?` · <span class="red">${s.lost.length} perdu${s.lost.length>1?'s':''}</span>`:''}${s.dup.length?` · <span class="dim">${s.dup.length} l'avai${s.dup.length>1?'en':''}t déjà</span>`:''}</span></div>`).join('');
  return `<h3 class="ih">Émissions radio de ce paquet <small>(${p.txLog.length})</small></h3>${rows}${p.txLog.length>40?`<div class="hint">… ${p.txLog.length-40} émissions de plus</div>`:''}`;
}

function renderPacketInspector(p, force){
  const sig=[p.id,p.txCount,p.live,p.status,p.detail?p.detail.size:0,p.txLog?p.txLog.length:0,p.tracker?`${p.tracker.attempt}${p.tracker.done}`:'',p.ackReceived,sim.nodes.length].join('|');
  if(!force && ui.pktSig===sig) return;
  ui.pktSig=sig;
  const el=$('#rightPanel');
  const scroll=el.scrollTop;
  const o=sim.nodeById(p.originId), d=p.destId?sim.nodeById(p.destId):null;
  const label=id=>esc(sim.nodeById(id)?.label||('#'+id));
  const statusTxt={pending:'en cours', delivered:'livré', dropped:'jamais livré', done:'terminé'}[p.status]||p.status;
  const reasons=Object.entries(p.lossReasons).sort((x,y)=>y[1]-x[1]);
  const path = p.deliveredPath || (p.route==='direct' ? [p.originId, ...p.presetPath, ...(p.destId?[p.destId]:[])] : null);
  el.innerHTML=`
    <div class="insp-title"><div class="name">Paquet #${p.id}</div><div class="type">${TYPE_LABEL[p.type]||p.type} · <span class="${p.status==='delivered'?'green':p.status==='dropped'?'red':''}">${statusTxt}</span>${p.manual?' · manuel':''}</div></div>
    <div class="insp-body">
      <div class="kv"><span class="k">Origine</span><span class="v">${o?label(o.id):'?'}</span></div>
      <div class="kv"><span class="k">Destination</span><span class="v">${d?label(d.id):'tous (diffusion)'}</span></div>
      <div class="kv"><span class="k">Charge utile</span><span class="v">${p.sizeBytes} o</span></div>
      <div class="kv"><span class="k">Routage</span><span class="v">${p.route==='direct'?'chemin appris (MeshCore)':'flood'}${sim.protocol==='meshtastic'?` · hop limit ${p.maxHops}`:''}</span></div>
      ${ackRows(p)}
      <div class="kv"><span class="k">Émissions radio (origine + relais)</span><span class="v">${p.txCount}</span></div>
      <div class="kv"><span class="k">Nœuds l'ayant reçu</span><span class="v">${p.reached.size-1} / ${sim.nodes.length-1}</span></div>
      <div class="kv"><span class="k">Copies en attente ou en vol</span><span class="v">${p.live}</span></div>
      ${p.deliveredAt!==null?`<div class="kv"><span class="k">Latence</span><span class="v green">${fmt((p.deliveredAt-p.createdAt)/1000,2)} s · ${p.deliveredHops} relais</span></div>`:''}
      ${path?`<h3 class="ih">${p.deliveredPath?'Chemin de la copie livrée':'Chemin imposé'}</h3>${path.map((id,i)=>`<div class="pathstep"><div class="n">${i+1}</div>${label(id)}${i<path.length-1?'<span class="arrow">→</span>':''}</div>`).join('')}`:''}
      ${receptionSection(p)}
      ${txTimelineSection(p)}
      ${reasons.length?`<h3 class="ih">Totaux des copies non reçues ou non relayées</h3>${reasons.map(([k,v])=>`<div class="kv"><span class="k">${LOSS_LABEL[k]||k}</span><span class="v">${v}</span></div>`).join('')}`:''}
    </div>
    <div class="insp-actions"><div class="mbtn" id="btnClearPkt">Fermer</div>${o?`<div class="mbtn" id="btnPktOrigin">Voir ${label(o.id)}</div>`:''}</div>`;
  el.scrollTop=scroll;
  applyPacketHighlight(p);
  $all('[data-rxnode]',el).forEach(r=>r.addEventListener('click',()=>{ const n=sim.nodeById(parseInt(r.dataset.rxnode)); if(n){ ui.map.panTo([n.lat,n.lng]); const m=markerEl(n.id); if(m){ m.classList.add('src'); setTimeout(()=>m.classList.remove('src'),900); } } }));
  $('#btnClearPkt').addEventListener('click',()=>{ ui.selectedPacket=null; ui.layers.path.clearLayers(); renderRightPanel(); renderLogList(true); });
  $('#btnPktOrigin')?.addEventListener('click',()=>{ ui.selectedPacket=null; ui.layers.path.clearLayers(); ui.selectedA=o.id; ui.selectedB=null; renderRightPanel(); highlightSelection(); ui.map.panTo([o.lat,o.lng]); });
  ui.layers.path.clearLayers();
  if(path){
    const pts=path.map(id=>sim.nodeById(id)).filter(Boolean).map(n=>[n.lat,n.lng]);
    L.polyline(pts,{color:p.deliveredPath?'#3ecf8e':'#f0a742', weight:3, opacity:.85, dashArray:p.deliveredPath?null:'6 5', interactive:false}).addTo(ui.layers.path);
  }
}

/* ---------------- qualité des liaisons (code couleur commun carte / tableau / journal) ---------------- */
const LINK_STATE={
  good:{label:'bonne', cls:'good', color:'#3ecf8e', help:'marge ≥ 10 dB : réception fiable'},
  fair:{label:'en limite', cls:'fair', color:'#f0a742', help:'marge de 0 à 10 dB : réception irrégulière'},
  none:{label:'impossible', cls:'bad', color:'#e5555f', help:'signal sous la sensibilité du récepteur : aucune réception'}
};
function stateOfMargin(m){ return m===null||m===undefined ? 'none' : m>=sim.cfg.goodMarginDb ? 'good' : m>=0 ? 'fair' : 'none'; }
function fmtMargin(m){ return m===null||m===undefined ? '–' : `${m>=0?'+':''}${fmt(m,0)} dB`; }
// cause principale d'une perte de liaison, en mots simples
function linkCause(q){
  if(!q.computed) return `trop loin (${fmtDist(q.distM)}, au-delà de la portée calculée)`;
  const pl=q.pl;
  const causes=[
    ['relief', pl.terrainDb>=pl.groundDb ? pl.terrainDb : 0],
    ['antennes trop basses (sol)', pl.groundDb>pl.terrainDb ? pl.groundDb : 0],
    ['arbres / bâti', pl.clutterDb+pl.termADb+pl.termBDb]
  ].sort((x,y)=>y[1]-x[1]);
  return causes[0][1]>=6 ? `${causes[0][0]} (${fmt(causes[0][1],0)} dB)` : `distance (${fmtDist(q.distM)})`;
}
function nodeName(id){ return esc(sim.nodeById(id)?.label||('#'+id)); }

/* ---------------- journal & tableau des liaisons ---------------- */
function renderLogFilters(){
  const tab=ui.bottomTab||'log';
  const popped=wsPoppedOut();
  const tabs=`<div class="btab ${tab==='log'?'active':''}" data-btab="log">Journal</div><div class="btab ${tab==='links'?'active':''}" data-btab="links" title="Qui reçoit qui : bilan de toutes les liaisons radio">Liaisons</div>`
    + `<div class="btab pop" id="btnPopout" title="${popped?'Remettre ce panneau en bas de la page':'Ouvrir ce panneau dans une fenêtre séparée, à poser sur un second écran'}">⧉ ${popped?'Réintégrer':'Détacher'}</div>`
    + `<span class="btab-sep"></span>`;
  if(tab==='log'){
    $('#logFilters').innerHTML = tabs + LOG_TAGS.map(t=>`<div class="chip ${ui.logFilter.has(t)?'active':''}" data-logf="${t}" title="${TAG_HELP[t]||''}" style="font-size:9.5px;">${t}</div>`).join('')
      + `<span class="hint" style="margin:0 0 0 6px">survol = explication · clic sur une ligne = qui a reçu le paquet</span>`
      + `<button type="button" class="log-clear" id="btnClearLog" title="Effacer toutes les lignes du journal (la simulation et les compteurs continuent)" aria-label="Effacer le journal">🗑</button>`;
  } else {
    $('#logFilters').innerHTML = tabs
      + Object.values(LINK_STATE).map(s=>`<span class="rxc ${s.cls}" title="${s.help}">${s.label}</span>`).join('')
      + `<span class="hint" style="margin:0 0 0 6px">${ui.selectedA&&sim.nodeById(ui.selectedA)?`liaisons de ${nodeName(ui.selectedA)} · cliquez sur la carte ailleurs qu'un nœud pour tout voir`:'cliquez un nœud pour ne voir que ses liaisons'} · clic sur une ligne = bilan détaillé</span>`;
  }
  $all('[data-btab]').forEach(c=>c.addEventListener('click',()=>{ ui.bottomTab=c.dataset.btab; ui.linksTableSig=null; renderLogFilters(); renderLogList(true); }));
  $('#btnPopout')?.addEventListener('click', wsPopoutToggle);
  $all('[data-logf]').forEach(c=>c.addEventListener('click',()=>{
    const t=c.dataset.logf; ui.logFilter.has(t)?ui.logFilter.delete(t):ui.logFilter.add(t);
    c.classList.toggle('active'); renderLogList(true);
  }));
  $('#btnClearLog')?.addEventListener('click',()=>{
    sim.events.length=0;
    renderLogList(true);
    toast('Journal effacé. La simulation, les compteurs et le détail des paquets sont conservés.');
  });
}
sim.onEvent = ()=>{ ui.logDirty=true; };

// pastilles colorées d'une ligne RX : ✓ reçu (vert / orange selon la marge), ✗ non reçu (rouge, avec la raison)
function rxChips(e){
  const x=e.x, head=esc(e.msg.split('→')[0])+'→ ';
  const chips=[];
  const ok=x.rx.filter(r=>r.st==='ok').sort((a,b)=>(b.m??-99)-(a.m??-99));
  ok.forEach(r=>{ const s=stateOfMargin(r.m)==='good'?'good':'fair';
    chips.push(`<span class="rxc ${s}" title="${nodeName(r.id)} a reçu le paquet · liaison ${LINK_STATE[s].label} (marge ${fmtMargin(r.m)})">✓ ${nodeName(r.id)} <i>${fmtMargin(r.m)}</i></span>`); });
  x.rx.filter(r=>r.st==='lost').forEach(r=>{
    chips.push(`<span class="rxc bad" title="${nodeName(r.id)} était à portée mais n'a pas décodé le paquet : ${RX_WHY[r.why]||r.why}">✗ ${nodeName(r.id)} <i>${RX_WHY[r.why]||r.why}</i></span>`); });
  x.rx.filter(r=>r.st==='out').forEach(r=>{
    chips.push(`<span class="rxc bad out" title="${nodeName(r.id)} ne capte pas ${nodeName(e.nodeId)} : liaison impossible (marge ${fmtMargin(r.m)})">✗ ${nodeName(r.id)} <i>hors de portée ${r.m!==null?fmtMargin(r.m):''}</i></span>`); });
  if(x.okMore) chips.push(`<span class="rxc good">+${x.okMore} autres reçus</span>`);
  if(x.lostMore) chips.push(`<span class="rxc bad">+${x.lostMore} autres perdus</span>`);
  if(x.dup) chips.push(`<span class="rxc dim" title="Ces nœuds avaient déjà reçu ce paquet par un autre chemin">${x.dup} l'avai${x.dup>1?'en':''}t déjà</span>`);
  if(x.outMore) chips.push(`<span class="rxc bad out">✗ ${x.outMore} hors de portée</span>`);
  if(!ok.length && !x.okMore) chips.unshift(`<span class="rxc bad strong">personne ne l'a reçu</span>`);
  return head+chips.join(' ');
}

function renderLogList(force){
  if((ui.bottomTab||'log')==='links') return renderLinksTable(force);
  if(!force && !ui.logDirty) return;
  ui.logDirty=false;
  const list=$('#logList'); if(!list) return;
  const out=[];
  for(let i=sim.events.length-1;i>=0 && out.length<250;i--){ const e=sim.events[i]; if(ui.logFilter.has(e.tag)) out.push(e); }
  const selId=ui.selectedPacket?ui.selectedPacket.id:null;
  list.innerHTML=out.map(e=>`<div class="log-row${e.packetId&&e.packetId===selId?' sel':''}" data-node="${e.nodeId||''}" data-pkt="${e.packetId||''}"><span class="log-t">${fmtTime(e.t)}.${String(Math.floor(e.t%1000)).padStart(3,'0')}</span><span class="log-tag ${e.tag}" title="${TAG_HELP[e.tag]||''}">${e.tag}</span><span class="log-msg">${e.tag==='RX'&&e.x?rxChips(e):esc(e.msg)}</span></div>`).join('');
}

// Tableau « qui reçoit qui » : une ligne par paire de nœuds, avec la marge dans chaque sens
function renderLinksTable(force){
  const list=$('#logList'); if(!list) return;
  const sel=ui.selectedA && !ui.selectedPacket ? sim.nodeById(ui.selectedA) : null;
  const sig=[sim.links.version, sim.links.dirty, sel?sel.id:0, sim.nodes.length, sim.nodes.filter(n=>n.active).length].join('|');
  if(!force && sig===ui.linksTableSig) return;
  ui.linksTableSig=sig;
  if(sim.nodes.length<2){ list.innerHTML=`<div class="lt-empty">Placez au moins deux nœuds pour voir leurs liaisons.</div>`; return; }
  if(sim.links.dirty){ list.innerHTML=`<div class="lt-empty">⏳ Calcul des liaisons radio… ${Math.round(sim.links.progress*100)} %</div>`; ui.linksTableSig=null; return; }
  const nodes=sim.nodes.filter(n=>n.active);
  const pairs=[];
  if(sel) nodes.forEach(n=>{ if(n!==sel) pairs.push([sel,n]); });
  else if(nodes.length<=60){ for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) pairs.push([nodes[i],nodes[j]]); }
  else {
    // gros réseau : liaisons bonnes et en limite uniquement (les impossibles se consultent nœud par nœud)
    const ids=new Map(nodes.map(n=>[n.id,n]));
    for(const n of nodes) for(const nb of sim.links.neighbors(n)) if(nb.margin>=0 && n.id<nb.node.id && ids.has(nb.node.id)) pairs.push([n,nb.node]);
  }
  const rows=pairs.map(([a,b])=>({a,b,q:sim.links.quality(a,b)}));
  rows.sort((x,y)=>(y.q.margin??-999)-(x.q.margin??-999));
  const count={good:0,fair:0,none:0}; rows.forEach(r=>count[r.q.state]++);
  const MAX=400;
  const dir=(from,to,m)=>{ const s=stateOfMargin(m); return `<span class="lt-dir ${LINK_STATE[s].cls}" title="${nodeName(from.id)} → ${nodeName(to.id)} : ${LINK_STATE[s].help}">${nodeName(to.id)} ${m!==null&&m>=0?'reçoit':'ne reçoit pas'} ${nodeName(from.id)} <i>${fmtMargin(m)}</i></span>`; };
  list.innerHTML = `
    <div class="lt-sum">
      <b>${sel?`Liaisons de ${nodeName(sel.id)}`:`${rows.length} liaison${rows.length>1?'s':''}${nodes.length>60?' utilisables (gros réseau)':''}`}</b>
      <span class="rxc good">${count.good} bonne${count.good>1?'s':''}</span>
      <span class="rxc fair">${count.fair} en limite</span>
      ${nodes.length>60&&!sel?'':`<span class="rxc bad">${count.none} impossible${count.none>1?'s':''}</span>`}
      <span class="hint">Marge = signal reçu − sensibilité du récepteur (${fmt(sim.sensitivity(),1)} dBm). Bonne ≥ ${sim.cfg.goodMarginDb} dB · en limite 0 à ${sim.cfg.goodMarginDb} dB · impossible &lt; 0.</span>
    </div>
    <div class="lt-row lt-head"><span></span><span>Nœuds</span><span>Distance</span><span>Dans un sens</span><span>Dans l'autre</span><span>Principale perte</span></div>
    ${rows.slice(0,MAX).map(({a,b,q})=>`<div class="lt-row st-${q.state}" data-la="${a.id}" data-lb="${b.id}" title="Cliquer pour le bilan de liaison détaillé">
      <span class="lt-state rxc ${LINK_STATE[q.state].cls}">${LINK_STATE[q.state].label}</span>
      <span class="lt-pair">${nodeName(a.id)} ↔ ${nodeName(b.id)}</span>
      <span class="lt-dist">${fmtDist(q.distM)}</span>
      ${q.computed?dir(a,b,q.mAB):'<span class="lt-dir bad">non calculée</span>'}
      ${q.computed?dir(b,a,q.mBA):'<span class="lt-dir bad">non calculée</span>'}
      <span class="lt-cause">${q.state==='good'?'—':linkCause(q)}</span>
    </div>`).join('')}
    ${rows.length>MAX?`<div class="lt-empty">… ${rows.length-MAX} autres liaisons (sélectionnez un nœud pour filtrer)</div>`:''}`;
}

$('#logList').addEventListener('click', e=>{
  const lr=e.target.closest('.lt-row[data-la]');
  if(lr){
    const a=sim.nodeById(parseInt(lr.dataset.la)), b=sim.nodeById(parseInt(lr.dataset.lb)); if(!a||!b) return;
    ui.selectedPacket=null; ui.selectedA=a.id; ui.selectedB=b.id; ui.ign=null;
    renderRightPanel('link'); highlightSelection();
    ui.map.fitBounds([[a.lat,a.lng],[b.lat,b.lng]],{padding:[80,80], maxZoom:14});
    return;
  }
  const r=e.target.closest('.log-row'); if(!r) return;
  const pk=sim.packets.get(parseInt(r.dataset.pkt)), nodeId=parseInt(r.dataset.node);
  if(pk){
    ui.selectedPacket=pk; renderRightPanel(); renderLogList(true);
    if(!ui.seenPacketHelp){ ui.seenPacketHelp=true; toast('Paquet sélectionné : la carte colore les nœuds qui l’ont reçu (vert), relayé (orange), perdu (rouge) ou jamais atteint (estompé). Le panneau de droite détaille chaque nœud et chaque émission ; ses lignes sont surlignées dans le journal.'); }
    return;
  }
  if(nodeId && sim.nodeById(nodeId)){ ui.selectedA=nodeId; ui.selectedB=null; ui.selectedPacket=null; renderRightPanel(); highlightSelection(); const n=sim.nodeById(nodeId); ui.map.panTo([n.lat,n.lng]); }
});

/* ---------------- transport ---------------- */
function renderTransport(){
  $('#transport').innerHTML=`
    <div class="transport-row">
      <div class="tbtn" id="tReset" title="Réinitialiser la simulation (garde les nœuds)">⏮</div>
      <div class="tbtn play" id="tPlay" title="Lecture / pause (Espace)">▶</div>
      <div class="tbtn" id="tStep" title="Avancer d'1 seconde">⏭</div>
      <div class="clock" id="tClock">00:00:00</div>
    </div>
    <div class="tslider">
      <label class="tlbl" for="speedRange">Vitesse</label>
      <input type="range" id="speedRange" min="0" max="${SPEEDS.length-1}" step="1" value="${ui.speedIdx}">
      <b class="tval" id="speedVal">×1</b>
    </div>
    <div class="tslider" title="Temps moyen entre deux messages envoyés par un même client (NodeInfo, position, télémétrie et adverts gardent leurs intervalles firmware)">
      <label class="tlbl" for="msgIntervalRange">Envois</label>
      <input type="range" id="msgIntervalRange" min="0" max="${MSG_INTERVALS.length-1}" step="1" value="${intervalIdxFromTraffic()}">
      <b class="tval" id="msgIntervalVal">–</b>
    </div>
    <div class="tnote" id="msgIntervalNet"></div>
    <div class="mini-stats">
      <div title="Paquets créés par les nœuds, tous types : messages, positions, télémétrie, adverts, ACK…">Paquets <b id="mGen">0</b></div>
      <div title="Transmissions sur les ondes, relais compris : un paquet relayé par 4 nœuds compte 5 émissions">Émissions <b id="mTx">0</b></div>
      <div title="Messages directs arrivés à leur destinataire">Msg livrés <b id="mDel">0</b></div>
      <div title="Messages directs jamais arrivés (plus aucune copie en circulation). Les messages encore en route ne comptent ni ici ni dans « livrés ».">Msg perdus <b id="mLost">0</b></div>
    </div>
    <div class="hint" id="tStatus" style="margin:0"></div>`;
  $('#tPlay').addEventListener('click',togglePlay);
  $('#tStep').addEventListener('click',()=>{ sim.links.work(1e9); sim.advance(1000); refreshLive(true); });
  $('#tReset').addEventListener('click',()=>{ sim.reset(); clearTxClasses(); ui.selectedPacket=null; ui.layers.path.clearLayers(); renderLogList(true); refreshLive(true); renderRightPanel(); toast('Simulation remise à zéro : horloge, files, statistiques et chemins appris effacés. Les nœuds sont conservés.'); });
  $('#speedRange').addEventListener('input',e=>{ ui.speedIdx=parseInt(e.target.value); $('#speedVal').textContent='×'+SPEEDS[ui.speedIdx]; });
  $('#speedVal').textContent='×'+SPEEDS[ui.speedIdx];
  $('#msgIntervalRange').addEventListener('input',e=>{ setMsgInterval(parseInt(e.target.value)); updateIntervalUI(); });
  $('#msgIntervalRange').addEventListener('change',()=>renderLeftPanel());
  updateIntervalUI();
}

/* ---------------- intervalle entre messages ---------------- */
// temps moyen (s) entre deux messages d'un même client ; le dernier cran coupe les messages automatiques
const MSG_INTERVALS=[10,20,30,60,120,300,360,600,900,1800,3600,7200,14400,43200,86400,Infinity];
function fmtInterval(s){
  if(!Number.isFinite(s)) return 'aucun';
  if(s<60) return `${Math.round(s)} s`;
  if(s<3600) return `${Math.round(s/60)} min`;
  return `${fmt(s/3600, s%3600?1:0)} h`;
}
function intervalIdxFromTraffic(){
  const rate=sim.traffic.msgPerHour();
  if(!rate) return MSG_INTERVALS.length-1;
  const s=3600/rate;
  let best=0;
  MSG_INTERVALS.forEach((v,i)=>{ if(Number.isFinite(v) && Math.abs(Math.log(v/s))<Math.abs(Math.log(MSG_INTERVALS[best]/s))) best=i; });
  return best;
}
function setMsgInterval(idx){
  const s=MSG_INTERVALS[idx], rate=Number.isFinite(s) ? 3600/s : 0;
  const preset=Object.entries(TRAFFIC_PRESETS).find(([,v])=>Math.abs(v.msgPerHour-rate)<1e-9);
  if(preset) sim.traffic.mode=preset[0];
  else { sim.traffic.mode='custom'; sim.traffic.customMsgPerHour=rate; }
  sim.traffic.invalidate();
}
function updateIntervalUI(){
  const sl=$('#msgIntervalRange'); if(!sl) return;
  if(document.activeElement!==sl) sl.value=intervalIdxFromTraffic();
  const rate=sim.traffic.msgPerHour();
  const clients=sim.nodes.filter(n=>n.active && n.role==='client').length;
  const who=sim.protocol==='meshcore'?'companion':'client';
  $('#msgIntervalVal').textContent = rate ? fmtInterval(3600/rate) : 'aucun';
  const perMin=rate*clients/60;
  $('#msgIntervalNet').textContent = !rate ? 'Messages automatiques coupés (envoi manuel uniquement)'
    : `Un message par ${who} toutes les ${fmtInterval(3600/rate)} en moyenne · ≈ ${fmt(perMin, perMin<1?2:perMin<10?1:0)} msg/min sur ${clients} ${who}${clients>1?'s':''}`;
}
function togglePlay(){
  ui.playing=!ui.playing;
  $('#tPlay').textContent=ui.playing?'⏸':'▶';
}

function frame(t){
  const dt=Math.min(250, t-ui.lastT); ui.lastT=t;
  if(ui.playing) sim.advance(dt*SPEEDS[ui.speedIdx]);
  else if(sim.links.dirty) sim.links.work(15);
  stepAnims(t);
  if(t-ui.lastRefresh>250){ ui.lastRefresh=t; refreshLive(); }
  requestAnimationFrame(frame);
}
function refreshLive(force){
  $('#tClock').textContent=fmtTime(sim.timeMs);
  const T=sim.totals;
  $('#mGen').textContent=T.generated; $('#mTx').textContent=T.tx; $('#mDel').textContent=T.msgDelivered;
  $('#mLost').textContent=T.msgDropped;   // même périmètre que « Msg livrés » : messages directs uniquement
  const st=$('#tStatus');
  st.textContent = sim.geoBusy ? '⏳ Chargement des données géographiques…' : (sim.links.dirty && sim.nodes.length) ? `⏳ Calcul des liaisons radio ${Math.round(sim.links.progress*100)} % (${sim.links.pending} paire(s))` : '';
  renderLogList();          // le panneau du bas reste visible sur tous les onglets, et peut être sur un autre écran
  if(!$('#page-sim').classList.contains('active') && !force){ if(ui.dashInited && $('#page-dash').classList.contains('active')) updateDashboardLive(); return; }
  renderMapOverlay();
  const linksChanged = sim.links.version!==ui.linksVer && !sim.links.dirty;
  if(linksChanged){ ui.linksVer=sim.links.version; updateCoverStatus(); updateDemStatus(); }
  drawRadioLinks();
  if(ui.selectedPacket) renderPacketInspector(ui.selectedPacket);
  else if(ui.selectedA && !ui.selectedB){ const n=sim.nodeById(ui.selectedA); if(n) renderNodeInspectorLive(n); }
  else if(ui.selectedA && ui.selectedB && linksChanged) renderRightPanel('link');
  if(ui.dashInited && $('#page-dash').classList.contains('active')) updateDashboardLive();
}

/* ---------------- dashboard ---------------- */
function renderDashboardPage(){
  const el=$('#page-dash');
  Object.values(ui.charts).forEach(c=>c.destroy()); ui.charts={};
  el.innerHTML=`<div class="pagewrap">
    <div class="hero"><h1>Dashboard — analyse réseau</h1>
      <p>Alimenté par la simulation de l'onglet Simulateur (protocole : <b id="dashProto" style="color:var(--cyan)"></b>). Points de mesure toutes les ${sim.cfg.historyBucketMs/1000} s de temps simulé ; la simulation continue de tourner sur cet onglet.</p></div>
    <div class="grid4" id="kpiRow" style="margin-bottom:18px;"></div>
    <div class="grid2">
      <div class="chartbox"><h4>Paquets créés / s</h4><canvas id="chGen"></canvas></div>
      <div class="chartbox"><h4>Émissions radio / s</h4><canvas id="chTx"></canvas></div>
      <div class="chartbox"><h4>Pertes &amp; collisions / s</h4><canvas id="chLoss"></canvas></div>
      <div class="chartbox"><h4>Émissions simultanées (pic sur l'intervalle)</h4><canvas id="chPeak"></canvas></div>
      <div class="chartbox"><h4>Occupation du canal perçue (moyenne, %)</h4><canvas id="chAir"></canvas></div>
      <div class="chartbox"><h4>Indice de congestion ${FID.badge('est')}</h4><canvas id="chCong"></canvas></div>
      <div class="chartbox"><h4>Latence moyenne des messages (ms)</h4><canvas id="chLat"></canvas></div>
      <div class="chartbox"><h4>Relais moyens par message livré</h4><canvas id="chHops"></canvas></div>
    </div>
    <div class="card" style="margin-top:18px;">
      <h2>Rapport d'analyse automatique</h2>
      <div class="sub">Calculé à partir des données produites par la simulation en cours.</div>
      <div class="mbtn" id="btnGenReport" style="display:inline-block;padding:8px 16px;">Générer le rapport</div>
      <div id="reportBox" style="margin-top:14px;"></div>
    </div>
  </div>`;
  const mk=(id,datasets)=>new Chart($('#'+id).getContext('2d'),{type:'line', data:{labels:[], datasets}, options:{
    animation:false, responsive:true, maintainAspectRatio:false,
    scales:{x:{display:false}, y:{beginAtZero:true, ticks:{color:'#6d7f8f',font:{size:9}}, grid:{color:'#1c2732'}}},
    plugins:{legend:{display:datasets.length>1, labels:{color:'#a9b8c6',boxWidth:10,font:{size:9}}}},
    elements:{point:{radius:0}, line:{tension:.25, borderWidth:1.6}}}});
  ui.charts.gen=mk('chGen',[{label:'créés',data:[],borderColor:'#49c8e8'}]);
  ui.charts.tx=mk('chTx',[{label:'émissions',data:[],borderColor:'#f0a742'}]);
  ui.charts.loss=mk('chLoss',[{label:'jamais livrés',data:[],borderColor:'#e5555f'},{label:'collisions',data:[],borderColor:'#b18cf0'},{label:'renvois (ACK manquant)',data:[],borderColor:'#f0a742'}]);
  ui.charts.peak=mk('chPeak',[{label:'simultanées',data:[],borderColor:'#49c8e8', stepped:true}]);
  ui.charts.air=mk('chAir',[{label:'occupation %',data:[],borderColor:'#f0a742'}]);
  ui.charts.cong=mk('chCong',[{label:'congestion',data:[],borderColor:'#e5555f'}]);
  ui.charts.lat=mk('chLat',[{label:'latence ms',data:[],borderColor:'#5b8def', spanGaps:true}]);
  ui.charts.hops=mk('chHops',[{label:'relais',data:[],borderColor:'#3ecf8e', spanGaps:true}]);
  ui.dashInited=true;
  updateDashboardLive();
  $('#btnGenReport').addEventListener('click',generateReport);
}
function updateDashboardLive(){
  if(!ui.dashInited || !$('#kpiRow')) return;
  const h=sim.history, labels=h.t.map(x=>x.toFixed(0));
  const set=(c,arrs)=>{ c.data.labels=labels; arrs.forEach((a,i)=>c.data.datasets[i].data=a); c.update('none'); };
  set(ui.charts.gen,[h.generated]); set(ui.charts.tx,[h.transmitted]); set(ui.charts.loss,[h.dropped,h.collisions,h.retx]);
  set(ui.charts.peak,[h.peakTx]); set(ui.charts.air,[h.airtimePct]); set(ui.charts.cong,[h.congestion]);
  set(ui.charts.lat,[h.latencyMs]); set(ui.charts.hops,[h.hops]);
  const T=sim.totals, last=a=>{ for(let i=a.length-1;i>=0;i--) if(a[i]!==null) return a[i]; return 0; };
  const dr=(T.msgDelivered+T.msgDropped)?T.msgDelivered/(T.msgDelivered+T.msgDropped)*100:null;
  const prof=REG_PROFILES[sim.regProfile];
  const kpis=[
    ['Renvois (ACK manquant)', sim.cfg.retxEnabled&&ackActive() ? T.retx : 'désactivés', sim.cfg.retxEnabled&&ackActive() ? ` · ${T.ackFailures} échec(s)` : ''],
    ['Émissions / s', fmt(last(h.transmitted),2), ''],
    ['Taux de livraison (messages)', dr===null?'–':fmt(dr,1), dr===null?'':'%'],
    ['Pic d’émissions simultanées', T.peakTx, ''],
    ['Occupation canal', fmt(last(h.airtimePct),1), '%'],
    ['Collisions cumulées', T.collisions, ''],
    ['Latence moyenne', fmt(last(h.latencyMs),0), 'ms'],
    ['Duty cycle max', prof.dutyCycle?fmt(Math.max(0,...sim.nodes.map(n=>n.currentDutyPct||0))*100,2)+' %':'N/A', ''],
  ];
  $('#dashProto').textContent=sim.protocol==='meshtastic'?'Meshtastic':'MeshCore';
  $('#kpiRow').innerHTML=kpis.map(([l,v,u])=>`<div class="kpi"><div class="l">${l}</div><div class="v">${v}<small>${u}</small></div></div>`).join('');
}
function generateReport(){
  const h=sim.history, T=sim.totals, active=sim.nodes.filter(n=>n.active), prof=REG_PROFILES[sim.regProfile];
  const last=a=>{ for(let i=a.length-1;i>=0;i--) if(a[i]!==null) return a[i]; return 0; };
  const finished=T.msgDelivered+T.msgDropped, dr=finished?T.msgDelivered/finished*100:0;
  const util=last(h.airtimePct), cong=last(h.congestion);
  const busiest=[...sim.nodes].sort((a,b)=>b.stats.tx-a.stats.tx)[0];
  const isolated=sim.links.dirty?0:active.filter(n=>!sim.links.neighbors(n).some(x=>x.viable)).length;
  const maxDuty=Math.max(0,...sim.nodes.map(n=>n.currentDutyPct||0))*100;
  const risk=cong>65?'élevé':cong>35?'moyen':'faible';
  let html=`
    <div class="kv"><span class="k">Temps simulé</span><span class="v">${fmtTime(sim.timeMs)}</span></div>
    <div class="kv"><span class="k">Messages directs terminés</span><span class="v">${finished} / ${T.msgSent} envoyés</span></div>
    <div class="kv"><span class="k">Taux de livraison</span><span class="v ${dr>80?'green':dr>50?'amber':'red'}">${fmt(dr,1)} %</span></div>
    <div class="kv"><span class="k">Émissions radio totales</span><span class="v">${T.tx} (${fmt(T.tx/Math.max(1,T.generated),1)} par paquet créé)</span></div>
    <div class="kv"><span class="k">Pic d'émissions simultanées</span><span class="v">${T.peakTx}</span></div>
    <div class="kv"><span class="k">ACK reçus / implicites</span><span class="v">${T.acks} / ${T.implicitAcks}</span></div>
    <div class="kv"><span class="k">Renvois / échecs sans ACK</span><span class="v">${sim.cfg.retxEnabled?T.retx:'désactivés'} / ${T.ackFailures}</span></div>
    <div class="kv"><span class="k">Occupation canal moyenne</span><span class="v">${fmt(util,1)} %</span></div>
    <div class="kv"><span class="k">Risque de saturation</span><span class="v ${risk==='élevé'?'red':risk==='moyen'?'amber':'green'}">${risk}</span></div>
    <h3 style="margin-top:16px">Recommandations ${FID.badge('est')}</h3>`;
  const recos=[];
  if(prof.dutyCycle && maxDuty>prof.dutyCycle*100*0.7) recos.push(['bad',`Le nœud le plus sollicité utilise ${fmt(maxDuty,2)} % de temps d'antenne sur l'heure (limite ${prof.dutyCycle*100} %). Réduisez le trafic, passez à un preset plus rapide (SF plus bas) ou limitez le nombre de relais.`]);
  if(busiest && busiest.stats.tx>0) recos.push(['warn',`<b>${esc(busiest.label)}</b> est l'émetteur le plus actif (${busiest.stats.tx} émissions dont ${busiest.stats.relayed} relais) : point de congestion potentiel.`]);
  if(finished>5 && dr<70) recos.push(['bad',`Taux de livraison faible (${fmt(dr,1)} %) : ${T.collisions} collisions observées. Moins de relais redondants (MeshCore, rôles Client) ou une meilleure couverture (repeaters en hauteur) amélioreraient la situation.`]);
  if(sim.cfg.retxEnabled && T.retx > Math.max(5, T.msgSent*0.3)) recos.push(['warn',`${T.retx} renvois pour ${T.msgSent} messages : une part importante du trafic sert à rattraper des pertes. Désactivez temporairement les renvois pour mesurer leur coût, ou réduisez la charge du canal.`]);
  if(isolated) recos.push(['warn',`${isolated} nœud(s) sans voisin radio viable. Relevez leur antenne au-dessus de la végétation / du bâti ou ajoutez un repeater sur un point haut.`]);
  if(sim.demMode!=='real') recos.push(['warn','Le relief réel n’est pas utilisé : les portées affichées ne reflètent pas le terrain.']);
  if(!recos.length) recos.push(['','Aucun signe de saturation dans les données actuelles.']);
  html+=recos.map(([c,t])=>`<div class="recobox ${c}">${t}</div>`).join('');
  $('#reportBox').innerHTML=html;
}

/* ---------------- comparateur ---------------- */
const NODE_COUNT_OPTIONS=[10,25,50,100,250,500,1000];
function renderComparatorPage(){
  const el=$('#page-compare');
  Object.values(ui.cmpCharts).forEach(c=>c.destroy()); ui.cmpCharts={};
  el.innerHTML=`<div class="pagewrap">
    <div class="hero">
      <h1>Meshtastic vs MeshCore — comprendre avant de déployer</h1>
      <p>Les deux protocoles reposent sur LoRa et un canal radio partagé, mais gèrent le relais des paquets de façon structurellement différente. Cette différence détermine directement la capacité de passage à l'échelle du réseau. Les comportements ci-dessous sont repris de la documentation et du code source de chaque firmware (voir bas de page).</p>
    </div>
    <div class="grid2" style="margin-bottom:16px;">
      <div class="protocard mt">
        <h3>🛰 Meshtastic — <span style="color:var(--cyan)">managed flood routing</span> ${FID.badge('proto')}</h3>
        <ul>
          <li><b>Tous les nœuds relaient</b> par défaut (sauf CLIENT_MUTE) : inondation avec suppression.</li>
          <li>Avant de relayer, un nœud attend un <b>délai aléatoire dépendant du SNR</b> : les nœuds lointains (SNR faible) relaient en premier, les <b>routers</b> passent avant les clients.</li>
          <li>Un client qui <b>entend un doublon</b> pendant son attente <b>annule</b> son relais ; un router ne l'annule jamais.</li>
          <li><b>Hop limit</b> sur 3 bits : 7 sauts maximum, 3 par défaut.</li>
          <li>Écoute du canal (CAD) avant chaque émission, file d'émission de 16 paquets.</li>
          <li>Messages texte avec <b>accusé de réception</b> : sans ACK, l'émetteur renvoie jusqu'à 2 fois ; entendre un voisin relayer vaut ACK implicite.</li>
          <li>Trafic de fond : NodeInfo toutes les 3 h, position et télémétrie toutes les heures, intervalles allongés automatiquement au-delà de 40 nœuds.</li>
          <li>Depuis la 2.6, un routage <b>next-hop</b> réduit la redondance des messages directs (non modélisé dans le Simulateur).</li>
        </ul>
      </div>
      <div class="protocard mc">
        <h3>📡 MeshCore — <span style="color:var(--violet)">relais limité + chemins appris</span> ${FID.badge('proto')}</h3>
        <ul>
          <li>Seuls les <b>repeaters</b> relaient. Les companions ne relaient jamais ; les room servers ont le relais désactivé par défaut.</li>
          <li>Le <b>premier message</b> vers un contact part en flood (plafond <code>flood.max</code>, 64 par défaut).</li>
          <li>Le destinataire renvoie en flood le <b>chemin</b> réellement emprunté ; les messages suivants sont <b>routés en direct</b> : seuls les repeaters du chemin retransmettent.</li>
          <li>Chaque message direct attend un <b>ACK</b> ; l'application renvoie en cas d'absence et, après plusieurs échecs sur un chemin, <b>revient au flood</b> pour en découvrir un nouveau.</li>
          <li>Délai de relais aléatoire proportionnel au temps d'antenne du paquet ; pas d'émission tant que la radio reçoit.</li>
          <li>Repeaters : <b>advert flood toutes les 47 h</b> ; advert zero-hop (non relayé) toutes les 2 min sur un repeater neuf, désactivé dès qu'il est configuré (réglable de 60 à 240 min).</li>
          <li>Les canaux de groupe n'ont pas de chemin : ils sont toujours floodés.</li>
        </ul>
      </div>
    </div>
    <div class="card">
      <h2>Comparaison structurée</h2>
      <div class="sub">Comportements par défaut ; certains paramètres varient selon la version du firmware.</div>
      <div style="overflow-x:auto"><table class="cmp">
        <tr><th>Élément</th><th>Meshtastic</th><th>MeshCore</th></tr>
        <tr><td>Architecture</td><td>Tous les nœuds relaient ; le rôle (Client/Router) change la priorité et l'annulation des doublons</td><td>Companion / Repeater / Room server — seul le Repeater relaie par défaut</td></tr>
        <tr><td>Routage</td><td>Flood géré ; next-hop optionnel pour les messages directs (2.6+)</td><td>Flood pour la découverte, puis routage direct par chemin appris</td></tr>
        <tr><td>Broadcast</td><td>Relayé par tous jusqu'au hop limit, avec suppression des doublons</td><td>Toujours floodé, relayé uniquement par les repeaters</td></tr>
        <tr><td>Advertising</td><td>NodeInfo toutes les 3 h, diffusé à tout le maillage</td><td>Flood toutes les 47 h ; zero-hop (voisins directs) optionnel, 60–240 min</td></tr>
        <tr><td>Accès au canal</td><td>CAD + fenêtre de contention (CWmin 3, CWmax 8)</td><td>Attente tant que la radio reçoit (+200 ms), délai de relais aléatoire</td></tr>
        <tr><td>Airtime en régime établi</td><td>Proportionnel au nombre de nœuds atteints à chaque saut</td><td>Proportionnel à la longueur du chemin appris</td></tr>
        <tr><td>Scalabilité</td><td>Se dégrade plus vite avec la densité (relais redondants)</td><td>Dégrade moins vite, mais dépend du nombre et du placement des repeaters</td></tr>
        <tr><td>Complexité</td><td>Simple : chaque appareil aide le réseau</td><td>Nécessite des repeaters bien placés (points hauts)</td></tr>
        <tr><td>Cas d'usage</td><td>Groupes mobiles, communautés ouvertes</td><td>Infrastructure fixe planifiée, échanges répétés entre mêmes contacts</td></tr>
      </table></div>
    </div>
    <div class="card">
      <h2>Simulation visuelle comparative ${FID.badge('est')}</h2>
      <div class="sub">Modèle analytique (pas géographique) : coût radio estimé pour le même trafic sur N nœuds. Pour une étude physique nœud par nœud, utilisez l'onglet <b>Simulateur</b>.</div>
      <div class="chiprow">${NODE_COUNT_OPTIONS.map(n=>`<div class="chip ${n===ui.cmpN?'active':''}" data-cmpn="${n}">${n} nœuds</div>`).join('')}</div>
      <div class="grid3" style="margin-top:16px;">
        <div class="chartbox"><h4>Transmissions par message</h4><canvas id="cmpChTx"></canvas></div>
        <div class="chartbox"><h4>Occupation du canal (%)</h4><canvas id="cmpChAir"></canvas></div>
        <div class="chartbox"><h4>Taux de livraison estimé (%)</h4><canvas id="cmpChDel"></canvas></div>
      </div>
      <div id="cmpSummary" style="margin-top:14px;"></div>
    </div>
    <div class="sourcefoot">
      <b>Sources</b> — meshtastic.org/docs/overview/mesh-algo · meshtastic.org/blog/why-meshtastic-uses-managed-flood-routing ·
      github.com/meshtastic/firmware (src/mesh/RadioInterface.cpp, FloodingRouter.cpp, Default.h) ·
      docs.meshcore.io/faq · github.com/meshcore-dev/MeshCore (src/Dispatcher.cpp, examples/simple_repeater, examples/simple_room_server) ·
      Semtech AN1200.22 · ETSI EN 300 220 · ITU-R P.526 (diffraction), P.2108 (clutter), P.833 (végétation) ·
      IGN RGE ALTI® (France), AWS Terrain Tiles (SRTM), OpenStreetMap (Overpass).
      Les mécanismes non documentés précisément sont signalés ${FID.badge('est')} et restent paramétrables.
    </div>
  </div>`;
  $all('[data-cmpn]').forEach(c=>c.addEventListener('click',()=>{ ui.cmpN=parseInt(c.dataset.cmpn); $all('[data-cmpn]').forEach(x=>x.classList.toggle('active',x===c)); renderComparatorCharts(); }));
  const mk=id=>new Chart($('#'+id).getContext('2d'),{type:'bar', data:{labels:['Meshtastic','MeshCore'], datasets:[{data:[0,0], backgroundColor:['#49c8e8','#b18cf0'], borderRadius:4}]},
    options:{animation:false, responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:'#a9b8c6'},grid:{display:false}}, y:{beginAtZero:true, ticks:{color:'#6d7f8f',font:{size:9}},grid:{color:'#1c2732'}}}}});
  ui.cmpCharts.tx=mk('cmpChTx'); ui.cmpCharts.air=mk('cmpChAir'); ui.cmpCharts.del=mk('cmpChDel');
  renderComparatorCharts();
}
function renderComparatorCharts(){
  const r=ComparatorModel.run(ui.cmpN,{hopLimit:sim.cfg.hopLimit, sf:sim.radioCfg.sf, bwKHz:sim.radioCfg.bwKHz});
  ui.cmpCharts.tx.data.datasets[0].data=[r.meshtastic.transmissionsPerMsg, r.meshcore.transmissionsPerMsg]; ui.cmpCharts.tx.update('none');
  ui.cmpCharts.air.data.datasets[0].data=[r.meshtastic.channelPct, r.meshcore.channelPct]; ui.cmpCharts.air.update('none');
  ui.cmpCharts.del.data.datasets[0].data=[r.meshtastic.deliveryPct, r.meshcore.deliveryPct]; ui.cmpCharts.del.update('none');
  $('#cmpSummary').innerHTML=`<div class="hint">À ${ui.cmpN} nœuds (densité fixe, hop limit ${sim.cfg.hopLimit}, SF${sim.radioCfg.sf}/${sim.radioCfg.bwKHz} kHz) : Meshtastic génère en moyenne <b style="color:var(--text-0)">${fmt(r.meshtastic.transmissionsPerMsg,1)}</b> transmissions par message, contre <b style="color:var(--text-0)">${fmt(r.meshcore.transmissionsPerMsg,1)}</b> pour MeshCore une fois les chemins appris (≈ ${fmt(r.meshcore.avgPathHops,1)} sauts).</div>`;
}

/* ---------------- démarrage ---------------- */
function boot(){
  initMap();
  renderLeftPanel();
  renderTransport();
  renderLogFilters();
  renderLogList(true);
  renderMapOverlay();
  renderMapLegend();
  renderComparatorPage();
  updateDemStatus(); updateCoverStatus();
  workspaceBoot();                 // réseau précédent restauré, enregistrement automatique armé
  requestAnimationFrame(t=>{ ui.lastT=t; requestAnimationFrame(frame); });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
