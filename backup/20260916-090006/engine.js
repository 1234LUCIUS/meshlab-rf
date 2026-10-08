/* =========================================================================
   MeshLab RF — Moteur de simulation Meshtastic / MeshCore
   ---------------------------------------------------------------------
   Moteur à ÉVÉNEMENTS DISCRETS (horodatage à la milliseconde, file de
   priorité) : les émissions, délais de relais, écoutes de canal et fins
   de réception ont lieu à leur instant exact, sans quantification par
   "tick" (l'ancien pas de 120 ms regroupait artificiellement les
   émissions et rendait inopérants les délais de contention de ~18 ms).

   Constantes reprises des sources des firmwares (sept. 2026) :
   - Meshtastic firmware, src/mesh/RadioInterface.{h,cpp} :
     CWmin = 3, CWmax = 8, slotTime = 2,5·Tsym + 7,6 ms (CAD 2 symboles),
     délai relais ROUTER = random(0, 2·CW)·slot, autres rôles =
     2·CWmax·slot + random(0, 2^CW)·slot, CW = map(SNR, −20..10, 3..8) ;
     délai d'émission propre = random(0, 2^CW)·slot, CW selon l'occupation
     du canal ; MAX_TX_QUEUE = 16 ; préambule 16 symboles.
   - Meshtastic FloodingRouter.cpp : un doublon entendu annule le relais en
     attente, sauf pour ROUTER / ROUTER_LATE.
   - Meshtastic Default.h : NodeInfo toutes les 3 h ; position et
     télémétrie toutes les 1 h (12 h pour un routeur), intervalles
     multipliés au-delà de 40 nœuds (congestionScalingCoefficient).
   - MeshCore examples/simple_repeater/MyMesh.cpp : délai de relais
     flood = random(0, 5·airtime·0,5), direct = random(0, 5·airtime·0,3) ;
     flood_max = 64, flood_max_advert = 8 ; advert flood toutes les 47 h ;
     advert zero-hop toutes les 2 min sur un répéteur NEUF seulement —
     src/helpers/CommonCLI.cpp le désactive dès la 1re configuration
     (plage autorisée 60–240 min) ; room server : disable_fwd = 1.
   - MeshCore src/Dispatcher.cpp : pas d'émission si la radio reçoit,
     nouvel essai après 200 ms (4 s max).
   - Renvois sur absence d'ACK :
     Meshtastic ReliableRouter / NextHopRouter : NUM_RELIABLE_RETX = 3
     (compteur démarré à 3 − 1 → 2 renvois, même identifiant de paquet) ;
     arrêt sur ACK ou "ACK implicite" (l'émetteur entend un voisin relayer
     son paquet) ; attente = 2·airtime + (2^CW + 2·CWmax + 2^5)·slot + 4,5 s.
     MeshCore companion_radio : attente flood = 500 ms + 16·airtime,
     direct = 500 ms + (6·airtime + 250 ms)·(sauts + 1) ; chaque essai est
     un nouveau paquet (numéro d'essai dans la charge utile). Le nombre
     d'essais est décidé par l'application → paramètre [Estimation].
   - Airtime LoRa : Semtech AN1200.22.
   - Duty cycle : ETSI EN 300 220 (fenêtre d'une heure).
   ========================================================================= */

const FID = {
  badge(kind){
    const map={phys:['phys','Physique'],proto:['proto','Protocole'],reg:['reg','Réglementaire'],est:['est','Estimation']};
    const [cls,label]=map[kind]||map.est;
    return `<span class="badge ${cls}">${label}</span>`;
  }
};

/* ---------------------------------------------------------------------
   RÉGLEMENTATION & PRESETS RADIO
--------------------------------------------------------------------- */
const REG_PROFILES = {
  eu868_10:{label:'EU868 — 869,40–869,65 MHz (10 %, 500 mW ERP)', dutyCycle:0.10, maxErpDbm:27, band:[869.4,869.65],
    note:"Sous-bande utilisée par défaut par Meshtastic (région EU_868 : 869,4–869,65 MHz, 10 %, 27 dBm) et par les réglages MeshCore européens usuels. Le 10 % ne vaut que pour cette sous-bande."},
  eu868_1:{label:'EU868 — 868,0–868,6 MHz (1 %, 25 mW ERP)', dutyCycle:0.01, maxErpDbm:14, band:[868.0,868.6],
    note:"Sous-bande 868,0–868,6 MHz de l'ETSI EN 300 220 : 1 % de duty cycle sur une heure glissante, 25 mW ERP."},
  us915:{label:'US915 (FCC 15.247) — sans duty cycle', dutyCycle:null, maxErpDbm:null, band:[902,928],
    note:"Pas de limite de duty cycle réglementaire (puissance conduite ≤ 30 dBm). La limite de 400 ms de dwell time ne concerne que les systèmes à saut de fréquence."},
  none:{label:'Aucune contrainte (laboratoire)', dutyCycle:null, maxErpDbm:null, band:null,
    note:'Pour étude théorique uniquement — aucune réglementation appliquée.'}
};

const MODEM_PRESETS = {
  mt_long_fast:    {label:'Meshtastic LONG_FAST (SF11 · 250 kHz · 4/5)', sf:11, bw:250, cr:1, freq:869.525, proto:'meshtastic'},
  mt_long_moderate:{label:'Meshtastic LONG_MODERATE (SF11 · 125 kHz · 4/8)', sf:11, bw:125, cr:4, freq:869.525, proto:'meshtastic'},
  mt_medium_slow:  {label:'Meshtastic MEDIUM_SLOW (SF10 · 250 kHz · 4/5)', sf:10, bw:250, cr:1, freq:869.525, proto:'meshtastic'},
  mt_medium_fast:  {label:'Meshtastic MEDIUM_FAST (SF9 · 250 kHz · 4/5)', sf:9, bw:250, cr:1, freq:869.525, proto:'meshtastic'},
  mt_short_fast:   {label:'Meshtastic SHORT_FAST (SF7 · 250 kHz · 4/5)', sf:7, bw:250, cr:1, freq:869.525, proto:'meshtastic'},
  mc_eu_narrow:    {label:'MeshCore EU/UK Narrow (SF8 · 62,5 kHz · 4/8)', sf:8, bw:62.5, cr:4, freq:869.618, proto:'meshcore'},
  custom:          {label:'Personnalisé'}
};

// SNR minimal de démodulation LoRa par SF (fiches Semtech) — [Physique]
const LORA_SNR_MIN = {6:-5, 7:-7.5, 8:-10, 9:-12.5, 10:-15, 11:-17.5, 12:-20};

const RadioModel = {
  noiseFloorDbm(bwKHz, nf=6){ return -174 + 10*Math.log10(bwKHz*1000) + nf; },
  // sensibilité = plancher de bruit + SNR minimal (≈ valeurs constructeur SX127x/SX126x)
  sensitivity(sf, bwKHz, nf=6){ return this.noiseFloorDbm(bwKHz,nf) + (LORA_SNR_MIN[sf] ?? -12.5); },
  symbolMs(sf, bwKHz){ return Math.pow(2,sf)/bwKHz; },
  // Temps d'antenne — Semtech AN1200.22
  airtimeMs(payloadBytes, sf, bwKHz, cr=1, preambleSym=16, explicitHeader=true, crc=true){
    const tSym=this.symbolMs(sf,bwKHz);
    const de = tSym>=16 ? 1 : 0; // Low Data Rate Optimize
    const ih = explicitHeader?0:1, crcBit=crc?1:0;
    const num = 8*payloadBytes - 4*sf + 28 + 16*crcBit - 20*ih;
    const nPayload = 8 + Math.max(Math.ceil(num/(4*(sf-2*de)))*(cr+4), 0);
    const tPreamble=(preambleSym+4.25)*tSym, tPayload=nPayload*tSym;
    return {totalMs:tPreamble+tPayload, tPreambleMs:tPreamble, tPayloadMs:tPayload, tSymMs:tSym};
  },
  // Meshtastic computeSlotTimeMsec() — max(2.25, NUM_SYM_CAD + 0.5)·Tsym + 0.2 + 0.4 + 7 ms
  slotTimeMs(sf, bwKHz){ return 2.5*this.symbolMs(sf,bwKHz) + 7.6; },
  erpDbm(node){ return node.txPowerDbm + node.antGainDbi - 2.15; }
};

/* ---------------------------------------------------------------------
   OUTILS
--------------------------------------------------------------------- */
class EventQueue{
  constructor(){ this.h=[]; this.seq=0; }
  get size(){ return this.h.length; }
  clear(){ this.h=[]; }
  _less(a,b){ return a.t<b.t || (a.t===b.t && a.s<b.s); }
  push(t,type,data){
    const e={t,s:this.seq++,type,data,cancelled:false}, h=this.h;
    h.push(e);
    let i=h.length-1;
    while(i>0){ const p=(i-1)>>1; if(this._less(h[i],h[p])){ [h[i],h[p]]=[h[p],h[i]]; i=p; } else break; }
    return e;
  }
  peek(){ return this.h[0]; }
  // retire des événements (ex. tous les GEN) puis reconstitue le tas — un tableau trié est un tas valide
  removeWhere(fn){ this.h=this.h.filter(e=>!e.cancelled && !fn(e)).sort((a,b)=>a.t-b.t||a.s-b.s); }
  pop(){
    const h=this.h; if(!h.length) return null;
    const top=h[0], last=h.pop();
    if(h.length){
      h[0]=last; let i=0;
      for(;;){
        const l=2*i+1, r=l+1; let m=i;
        if(l<h.length && this._less(h[l],h[m])) m=l;
        if(r<h.length && this._less(h[r],h[m])) m=r;
        if(m===i) break;
        [h[i],h[m]]=[h[m],h[i]]; i=m;
      }
    }
    return top;
  }
}
const randInt = n => Math.floor(Math.random()*Math.max(0,n)); // Arduino random(0, n) → [0, n)
const arduinoMap = (x, inMin, inMax, outMin, outMax) => Math.trunc((Math.trunc(x)-inMin)*(outMax-outMin)/(inMax-inMin)+outMin);
const gaussian = ()=>{ let u=0,v=0; while(u===0) u=Math.random(); while(v===0) v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
const dbmToMw = dbm => Math.pow(10, dbm/10);

/* ---------------------------------------------------------------------
   STRUCTURES — Node / Packet
--------------------------------------------------------------------- */
let _nodeSeq=1, _pktSeq=1, _txSeq=1;

const DEFAULT_NODE_PROFILES = {
  client:   {heightM:2,  txPowerDbm:20, antGainDbi:2},
  router:   {heightM:10, txPowerDbm:22, antGainDbi:3},
  repeater: {heightM:15, txPowerDbm:22, antGainDbi:5}
};

class MeshNode{
  constructor(lat,lng,opts={}){
    const def = DEFAULT_NODE_PROFILES[opts.role||'client'];
    this.id=_nodeSeq++;
    this.lat=lat; this.lng=lng;
    this.role=opts.role||'client';        // client | router | repeater
    this.heightM=opts.heightM ?? def.heightM; // hauteur de l'antenne au-dessus du sol
    this.txPowerDbm=opts.txPowerDbm ?? def.txPowerDbm;
    this.antGainDbi=opts.antGainDbi ?? def.antGainDbi;
    this.label=opts.label || ('N'+this.id);
    this.active=true;
    this.geoVer=0;                         // incrémenté à chaque déplacement / changement de hauteur
    this.resetRuntime();
  }
  resetRuntime(){
    this.queue=[];                // file d'émission locale (items)
    this.seen=new Map();          // packetId → instant de 1re réception (déduplication)
    this.knownPaths=new Map();    // MeshCore : contactId → [repeaterIds]
    this.pathFails=new Map();
    this.txWindow=[];             // {t, dur} pour le duty cycle glissant
    this.txUntil=0;
    this.util=0; this.utilT=0;    // occupation du canal perçue (moyenne exponentielle, τ = 60 s)
    this._txEvt=null; this._dutyLogged=-1e9;
    this.currentDutyPct=0; this.dutyState='ok';
    this.stats={generated:0, tx:0, rx:0, dupes:0, relayed:0, suppressed:0, delivered:0, dropped:0, retx:0,
      collisions:0, halfDuplex:0, weak:0, cadBusy:0, queueDrops:0, airtimeMs:0, queueMax:0};
  }
}

class Packet{
  constructor(o){
    this.id=_pktSeq++;
    this.originId=o.originId;
    this.destId=o.destId ?? null;      // null = diffusion
    this.type=o.type;                   // MESSAGE | BROADCAST | POSITION | TELEMETRY | NODEINFO | ACK | ADVERT_ZERO | ADVERT_FLOOD | PATH
    this.sizeBytes=o.sizeBytes;
    this.maxHops=o.maxHops;
    this.createdAt=o.createdAt;
    this.route=o.route||'flood';        // flood | direct (MeshCore) — route du dernier essai
    this.presetPath=o.presetPath||null; // MeshCore : répéteurs à emprunter, dans l'ordre (dernier essai)
    this.tracker=null;                  // suivi d'accusé de réception (paquets qui demandent un ACK)
    this.ackReceived=false;             // un vrai ACK est revenu jusqu'à l'émetteur
    this.ackedAttempt=0;                // dernier essai auquel le destinataire a répondu
    this.meta=o.meta||null;
    this.manual=!!o.manual;
    this.status='pending';              // pending | delivered | dropped | done
    this.live=0;                        // copies en file ou en vol
    this.deliveredAt=null; this.deliveredHops=null; this.deliveredPath=null;
    this.txCount=0;
    this.reached=new Set([o.originId]);
    this.relayers=new Set();
    this.lossReasons={};
    this.detail=new Map();              // nodeId → {st, t, from, hops, rssi, dups, lost, relay} (effacé pour les vieux paquets)
    this.txLog=[];                      // bilan de chaque émission radio de ce paquet
  }
}

const TYPE_LABEL = {MESSAGE:'message direct', BROADCAST:'message de canal', POSITION:'position', TELEMETRY:'télémétrie',
  NODEINFO:'NodeInfo', ACK:'ACK', ADVERT_ZERO:'advert zero-hop', ADVERT_FLOOD:'advert flood', PATH:'retour de chemin'};
const LOSS_LABEL = {hop_limit:'limite de sauts', flood_max:'flood.max atteint', not_in_path:'hors du chemin appris',
  role_no_relay:'rôle non relayeur', zero_hop:'zero-hop (jamais relayé)', collision:'collision', half_duplex:'récepteur en émission',
  weak:'signal trop faible (évanouissement)', queue_full:'file d’émission pleine', no_neighbor:'aucun voisin radio', no_ack:'aucun ACK reçu'};

/* ---------------------------------------------------------------------
   TABLE DES LIAISONS — pertes de trajet mises en cache par paire,
   calcul incrémental et fractionné dans le temps (pas de gel de l'UI)
--------------------------------------------------------------------- */
class LinkTable{
  constructor(sim){
    this.sim=sim;
    this.pairs=new Map();     // clé paire → {ga, gb, env, pl}
    this.adj=new Map();       // nodeId → [{node, rssi, snr, margin, viable, pl}] (signal émis par nodeId, reçu par node)
    this.rssi=new Map();      // (from*2^20 + to) → dBm
    this.dirty=true; this.version=0;
    this._job=null; this.progress=1; this.pending=0;
  }
  static key(a,b){ return a<b ? a*1048576+b : b*1048576+a; }
  invalidate(){ this.dirty=true; this._job=null; }
  envKey(){
    const s=this.sim, d=s.activeDem(), c=s.activeCover();
    return [s.radioCfg.freqMHz, s.demMode, d?d.version:0, d&&d.z, c?c.version:0,
      s.clutterCfg.enabled, s.clutterCfg.treeH, s.clutterCfg.builtH, s.clutterCfg.gammaTree, s.kFactor].join('|');
  }
  maxRangeKm(){
    const s=this.sim;
    if(!s.nodes.length) return 1;
    const maxEirp=Math.max(...s.nodes.map(n=>n.txPowerDbm+n.antGainDbi));
    const maxGain=Math.max(...s.nodes.map(n=>n.antGainDbi));
    const budget=maxEirp+maxGain-(s.sensitivity()-20); // on garde les signaux jusqu'à 20 dB sous la sensibilité (interférences)
    const km=Math.pow(10,(budget-32.44-20*Math.log10(s.radioCfg.freqMHz))/20);
    return Math.min(km, s.cfg.maxLinkKm);
  }
  _startJob(){
    const s=this.sim, env=this.envKey();
    const nodes=s.nodes, rangeKm=this.maxRangeKm();
    const lat0=nodes.length?nodes[0].lat:0, kx=111.32*Math.cos(Geo.toRad(lat0)), ky=111.32;
    const cell=Math.max(rangeKm,0.5), buckets=new Map();
    nodes.forEach(n=>{
      const k=Math.floor(n.lng*kx/cell)+':'+Math.floor(n.lat*ky/cell);
      if(!buckets.has(k)) buckets.set(k,[]);
      buckets.get(k).push(n);
    });
    const candidates=[], todo=[];
    nodes.forEach(a=>{
      const cx=Math.floor(a.lng*kx/cell), cy=Math.floor(a.lat*ky/cell);
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        const list=buckets.get((cx+dx)+':'+(cy+dy)); if(!list) continue;
        for(const b of list){
          if(b.id<=a.id) continue;
          const dKm=Math.hypot((a.lng-b.lng)*kx,(a.lat-b.lat)*ky);
          if(dKm>rangeKm) continue;
          candidates.push([a,b]);
          const e=this.pairs.get(LinkTable.key(a.id,b.id));
          if(!e || e.env!==env || e.ga!==(a.id<b.id?a.geoVer:b.geoVer) || e.gb!==(a.id<b.id?b.geoVer:a.geoVer)) todo.push([a,b]);
        }
      }
    });
    this._job={env, candidates, todo, idx:0};
    this.pending=todo.length;
  }
  // avance le calcul d'au plus budgetMs ; renvoie true quand la table est prête
  work(budgetMs=25){
    if(!this.dirty) return true;
    if(this.sim.geoBusy) return false;   // on attend le relief / l'occupation du sol avant de calculer
    if(!this.sim.nodes.length){ this.adj=new Map(); this.rssi=new Map(); this.dirty=false; this.version++; return true; }
    if(!this._job) this._startJob();
    const job=this._job, s=this.sim, envObj=s.propEnv(), t0=performance.now();
    while(job.idx<job.todo.length){
      const [a,b]=job.todo[job.idx++];
      const [lo,hi]=a.id<b.id?[a,b]:[b,a];
      const pl=Propagation.pathLoss(lo,hi,envObj);
      this.pairs.set(LinkTable.key(a.id,b.id), {ga:lo.geoVer, gb:hi.geoVer, env:job.env, pl});
      if((job.idx & 15)===0 && performance.now()-t0>budgetMs) break;
    }
    this.progress = job.todo.length ? job.idx/job.todo.length : 1;
    if(job.idx<job.todo.length) return false;
    this._buildAdjacency(job.candidates);
    this.dirty=false; this._job=null; this.version++; this.progress=1; this.pending=0;
    return true;
  }
  rebuildAdjacencyOnly(){ // puissance, gain, SF, BW : pas besoin de recalculer les pertes de trajet
    if(this.dirty) return;
    const cands=[];
    const ids=new Map(this.sim.nodes.map(n=>[n.id,n]));
    for(const k of this.pairs.keys()){
      const a=ids.get(Math.floor(k/1048576)), b=ids.get(k%1048576);
      if(a&&b) cands.push([a,b]);
    }
    this._buildAdjacency(cands); this.version++;
  }
  _buildAdjacency(candidates){
    const s=this.sim, sens=s.sensitivity(), nf=s.noiseFloor(), keep=sens-20, sigma=s.cfg.fadingSigmaDb;
    this.adj=new Map(); this.rssi=new Map();
    s.nodes.forEach(n=>this.adj.set(n.id,[]));
    for(const [a,b] of candidates){
      const e=this.pairs.get(LinkTable.key(a.id,b.id)); if(!e) continue;
      const loss=e.pl.totalDb;
      for(const [tx,rx] of [[a,b],[b,a]]){
        const rssi=tx.txPowerDbm+tx.antGainDbi+rx.antGainDbi-loss;
        if(rssi<keep) continue;
        const margin=rssi-sens;
        this.adj.get(tx.id).push({node:rx, rssi, snr:rssi-nf, margin, viable:margin>=0, reachable:margin>-3*sigma, pl:e.pl});
        this.rssi.set(tx.id*1048576+rx.id, rssi);
      }
    }
    this.adj.forEach(list=>list.sort((x,y)=>y.rssi-x.rssi));
  }
  rssiOf(fromId,toId){ const v=this.rssi.get(fromId*1048576+toId); return v===undefined?null:v; }
  // marge nominale (dB) du signal émis par `from` et reçu par `to` : > 0 = au-dessus de la sensibilité ; null si non calculée
  margin(from,to){
    const e=this.pairs.get(LinkTable.key(from.id,to.id)); if(!e) return null;
    return from.txPowerDbm+from.antGainDbi+to.antGainDbi-e.pl.totalDb-this.sim.sensitivity();
  }
  // qualité d'une liaison dans les deux sens : good (marge ≥ goodMarginDb), fair (0 à goodMarginDb), none (< 0)
  quality(a,b){
    const e=this.pairs.get(LinkTable.key(a.id,b.id));
    if(!e) return {state:'none', computed:false, distM:Geo.distanceM(a,b), margin:null, mAB:null, mBA:null};
    const mAB=this.margin(a,b), mBA=this.margin(b,a), m=Math.min(mAB,mBA);
    return {state: m>=this.sim.cfg.goodMarginDb ? 'good' : m>=0 ? 'fair' : 'none', computed:true, distM:e.pl.distM, pl:e.pl, margin:m, mAB, mBA};
  }
  neighbors(node){ return this.adj.get(node.id)||[]; }
  pathLossOf(a,b){ const e=this.pairs.get(LinkTable.key(a.id,b.id)); return e?e.pl:null; }
}

/* ---------------------------------------------------------------------
   TRAFIC — flux périodiques (phase aléatoire) et flux de Poisson
--------------------------------------------------------------------- */
const TRAFFIC_PRESETS = {
  off:    {label:'Aucun (manuel)', msgPerHour:0},
  calm:   {label:'Calme',   msgPerHour:0.5},
  normal: {label:'Normal',  msgPerHour:2},
  busy:   {label:'Soutenu', msgPerHour:10},
  crisis: {label:'Crise',   msgPerHour:60},
};

class TrafficEngine{
  constructor(sim){ this.sim=sim; this.mode='normal'; this.customMsgPerHour=4; this.dmShare=0.5; this.background=true; this.dirty=true; }
  msgPerHour(){ return this.mode==='custom' ? this.customMsgPerHour : (TRAFFIC_PRESETS[this.mode]?.msgPerHour||0); }
  // Meshtastic congestionScalingCoefficient : 1 + (nœuds − 40)·2^SF/(BW·100) au-delà de 40 nœuds
  mtScaling(){
    const s=this.sim, n=s.nodes.filter(x=>x.active).length;
    return n<=40 ? 1 : 1+(n-40)*Math.pow(2,s.radioCfg.sf)/(s.radioCfg.bwKHz*100);
  }
  streamsFor(node){
    const s=this.sim, out=[], H=3600e3, isInfra=node.role!=='client';
    const rate=this.msgPerHour();
    if(rate>0 && node.role==='client') out.push({kind:'user', poissonMs:H/rate});
    if(!this.background) return out;
    if(s.protocol==='meshtastic'){
      const k = node.role==='router' ? 1 : this.mtScaling();
      out.push({kind:'NODEINFO', periodMs:3*H, size:[50,80]});
      out.push({kind:'POSITION', periodMs:(isInfra?12*H:1*H*k), size:[25,45]});
      out.push({kind:'TELEMETRY', periodMs:(isInfra?12*H:1*H*k), size:[25,40]});
    } else {
      if(node.role!=='client'){ // répéteurs et room servers
        if(s.cfg.mcLocalAdvertMin>0) out.push({kind:'ADVERT_ZERO', periodMs:s.cfg.mcLocalAdvertMin*60e3, size:[100,130]});
        out.push({kind:'ADVERT_FLOOD', periodMs:s.cfg.mcFloodAdvertH*H, size:[100,130]});
      }
    }
    return out;
  }
  invalidate(){ this.dirty=true; }
  // (re)planifie tous les flux ; appelé paresseusement par le moteur quand la config a changé
  rebuild(){
    const s=this.sim;
    s.q.removeWhere(e=>e.type==='GEN');
    s.nodes.forEach(n=>{ if(n.active) this.streamsFor(n).forEach(st=>this._schedule(n, st, true)); });
    this.dirty=false;
  }
  _schedule(node, st, first){
    const s=this.sim;
    let dt;
    if(st.poissonMs) dt = -Math.log(1-Math.random())*st.poissonMs;
    else dt = first ? Math.random()*st.periodMs : st.periodMs*(0.95+Math.random()*0.1); // 1re occurrence à phase aléatoire → pas de rafale synchronisée
    s.q.push(s.timeMs+dt,'GEN',{node, st});
  }
  fire(data){
    const s=this.sim, {node, st}=data;
    if(!node.active || !s.nodes.includes(node)) return;
    this._schedule(node, st, false);
    const rnd=([a,b])=>Math.round(a+Math.random()*(b-a));
    if(st.kind==='user'){
      const peers=s.nodes.filter(x=>x.active && x.id!==node.id && x.role==='client');
      if(Math.random()<this.dmShare && peers.length){
        s.originate(node, peers[randInt(peers.length)], 'MESSAGE', rnd([20,120]));
      } else {
        s.originate(node, null, 'BROADCAST', rnd([20,120]));
      }
    } else {
      s.originate(node, null, st.kind, rnd(st.size));
    }
  }
}

/* ---------------------------------------------------------------------
   PROTOCOLES
--------------------------------------------------------------------- */
const ProtocolModel = {
  // Octets réellement émis : charge utile + en-têtes
  onAirBytes(sim, item){
    const p=item.packet;
    if(sim.protocol==='meshtastic') return p.sizeBytes + 16;                       // en-tête LoRa Meshtastic 16 octets
    const pathLen = item.route==='direct' ? Math.max(0,(item.presetPath||[]).length-item.pathCursor) : item.hopsSoFar;
    return p.sizeBytes + 2 + pathLen;                                              // header + path_len + 1 octet par saut
  },

  // Le paquet demande-t-il un accusé de réception ?
  wantsAck(sim, type){
    if(sim.protocol==='meshtastic') return sim.cfg.mtAckEnabled && (type==='MESSAGE' || type==='BROADCAST'); // want_ack des messages texte (ACK implicite pour le canal)
    return type==='MESSAGE';                                                        // MeshCore : messages directs uniquement (pas d'ACK sur un canal)
  },

  // Délai d'attente de l'ACK avant de considérer l'essai comme perdu
  ackTimeoutMs(sim, node, item){
    const air=sim.airtime(ProtocolModel.onAirBytes(sim,item));
    if(sim.protocol==='meshtastic'){
      const cw=arduinoMap(sim.nodeUtilPct(node),0,100,3,8);
      return 2*air + (Math.pow(2,cw) + 2*8 + Math.pow(2,5))*sim.slotMs() + 4500;  // RadioInterface::getRetransmissionMsec
    }
    if(item.route==='direct') return 500 + (air*6 + 250)*(item.presetPath.length+1); // calcDirectTimeoutMillisFor
    return 500 + 16*air;                                                            // calcFloodTimeoutMillisFor
  },

  // délai avant la 1re émission d'un paquet produit localement
  originDelayMs(sim, node){
    if(sim.protocol==='meshtastic'){
      const cw=arduinoMap(sim.nodeUtilPct(node),0,100,3,8);
      return randInt(Math.pow(2,cw))*sim.slotMs();
    }
    return 0;
  },

  // délai de relais / nouvel essai après canal occupé
  relayDelayMs(sim, node, item){
    const p=item.packet;
    if(sim.protocol==='meshtastic'){
      const slot=sim.slotMs(), cw=arduinoMap(Math.max(-20,Math.min(10,item.rxSnr??0)),-20,10,3,8);
      if(node.role!=='client') return randInt(2*cw)*slot;           // ROUTER : relaie tôt
      return 2*8*slot + randInt(Math.pow(2,cw))*slot;                // CLIENT : laisse passer les routeurs d'abord
    }
    const air=sim.airtime(ProtocolModel.onAirBytes(sim,item));
    const factor = item.route==='direct' ? sim.cfg.mcDirectTxDelayFactor : sim.cfg.mcTxDelayFactor;
    return randInt(5*Math.floor(air*factor)+1);
  },

  // `item` = copie reçue ; renvoie {relay, reason}
  relayDecision(sim, node, item){
    const p=item.packet;
    if(p.type==='ADVERT_ZERO') return {relay:false, reason:'zero_hop'};
    if(sim.protocol==='meshtastic'){
      if(p.maxHops-item.hopsSoFar<=0) return {relay:false, reason:'hop_limit'};
      return {relay:true, mode:'flood'};
    }
    // MeshCore : seuls les répéteurs relaient (companion : jamais ; room server : disable_fwd = 1 par défaut)
    if(node.role!=='repeater' && !(node.role==='router' && sim.cfg.mcRoomServerForward)) return {relay:false, reason:'role_no_relay'};
    if(item.route==='direct'){
      return item.presetPath[item.pathCursor]===node.id ? {relay:true, mode:'direct'} : {relay:false, reason:'not_in_path'};
    }
    const max = p.type==='ADVERT_FLOOD' ? 8 : sim.cfg.mcFloodMax;
    if(item.hopsSoFar>=max) return {relay:false, reason:'flood_max'};
    return {relay:true, mode:'flood'};
  },

  // Meshtastic : entendre un doublon annule le relais en attente, sauf rôle ROUTER
  cancelsOnDuplicate(sim, node){ return sim.protocol==='meshtastic' && node.role==='client'; },

  // Le destinataire répond à une copie (1re réception ou nouvel essai) : ACK / retour de chemin
  sendAck(sim, dest, packet, item){
    const origin=sim.nodeById(packet.originId);
    if(!origin || !packet.tracker) return;
    packet.ackedAttempt=Math.max(packet.ackedAttempt, item.attempt);
    if(sim.protocol==='meshtastic'){
      if(packet.destId!==null) sim.originate(dest, origin, 'ACK', 8, {ackFor:packet.id});
      return;
    }
    if(item.route==='flood'){
      // le destinataire renvoie en flood le chemin réellement suivi par la copie reçue, qui contient aussi l'ACK
      sim.originate(dest, origin, 'PATH', 12+item.relays.length, {learnPathTo:dest.id, path:item.relays.slice(), ackFor:packet.id});
    } else {
      sim.originate(dest, origin, 'ACK', 8, {ackFor:packet.id}, item.presetPath.slice().reverse());
    }
  },

  onDelivered(sim, dest, packet, item){
    if(ProtocolModel.wantsAck(sim, packet.type) && packet.destId!==null) ProtocolModel.sendAck(sim, dest, packet, item);
    if(packet.type==='PATH' && packet.meta && packet.meta.learnPathTo){
      dest.knownPaths.set(packet.meta.learnPathTo, packet.meta.path);
      dest.pathFails.delete(packet.meta.learnPathTo);
      sim.log('PATH', dest, `${dest.label} apprend le chemin vers ${sim.nodeById(packet.meta.learnPathTo)?.label||'?'} : ${packet.meta.path.length? packet.meta.path.map(id=>sim.nodeById(id)?.label||id).join(' → ') : 'direct (voisin)'}`, packet);
    }
    if((packet.type==='ACK' || packet.type==='PATH') && packet.meta && packet.meta.ackFor) sim._ackReceived(packet.meta.ackFor, 'ack');
  },

  // sans renvois : on compte les messages perdus sur un chemin appris et on l'oublie après mcPathFailMax échecs
  onFailed(sim, packet){
    if(sim.cfg.retxEnabled && packet.tracker) return; // géré par les renvois (retour au flood au dernier essai)
    if(sim.protocol!=='meshcore' || packet.type!=='MESSAGE' || packet.route!=='direct') return;
    const origin=sim.nodeById(packet.originId); if(!origin) return;
    const n=(origin.pathFails.get(packet.destId)||0)+1;
    origin.pathFails.set(packet.destId,n);
    if(n>=sim.cfg.mcPathFailMax){
      origin.knownPaths.delete(packet.destId); origin.pathFails.delete(packet.destId);
      sim.log('PATH', origin, `${origin.label} : ${n} échecs sur le chemin appris vers ${sim.nodeById(packet.destId)?.label||'?'} — retour au flood`, packet);
    }
  }
};

/* ---------------------------------------------------------------------
   MOTEUR DE SIMULATION
--------------------------------------------------------------------- */
class SimulationEngine{
  constructor(){
    this.nodes=[];
    this.protocol='meshtastic';
    this.radioCfg={freqMHz:869.525, sf:11, bwKHz:250, cr:1, preset:'mt_long_fast'};
    this.regProfile='eu868_10';
    this.cfg={
      hopLimit:3, mtAckEnabled:true,
      mcFloodMax:64, mcTxDelayFactor:0.5, mcDirectTxDelayFactor:0.3, mcPathFailMax:3, mcRoomServerForward:false,
      mcLocalAdvertMin:0, mcFloodAdvertH:47,
      retxEnabled:true, mcMaxAttempts:3,
      preambleSym:16, noiseFigureDb:6, captureDb:6, fadingSigmaDb:3,
      queueMax:16, dutyWindowMs:3600e3, maxLinkKm:80, historyBucketMs:5000,
      goodMarginDb:10   // seuil "bonne liaison" : 10 dB au-dessus de la sensibilité absorbe l'évanouissement habituel
    };
    // environnement géographique
    this.demMode='real';           // real | synthetic | none
    this.realDem=new TerrariumDEM();
    this.syntheticDem=new SyntheticDEM();
    this.cover=new OsmLandCover();
    this.coverEnabled=true;
    this.clutterCfg={enabled:true, treeH:15, builtH:10, gammaTree:0.25, exclusionM:100};
    this.kFactor=4/3;
    this.geoBusy=false;            // true pendant le chargement des données géographiques

    this.links=new LinkTable(this);
    this.traffic=new TrafficEngine(this);
    this.q=new EventQueue();
    this.timeMs=0;
    this.activeTx=[];
    this.packets=new Map();
    this.events=[]; this.maxEvents=4000;
    this.onEvent=null; this.onTxStart=null; this.onTxEnd=null; this.onStats=null;
    this._resetCounters();
    this._statsEvt=null;
  }

  /* ---------- accès ---------- */
  nodeById(id){ return this.nodes.find(n=>n.id===id); }
  activeDem(){ return this.demMode==='real' ? this.realDem : this.demMode==='synthetic' ? this.syntheticDem : null; }
  activeCover(){ return (this.coverEnabled && this.cover.cells) ? this.cover : null; }
  propEnv(){
    return {dem:this.activeDem(), cover:this.activeCover(), freqMHz:this.radioCfg.freqMHz, kFactor:this.kFactor,
      clutter:{...this.clutterCfg, enabled:this.clutterCfg.enabled && !!this.activeCover()}, stepM:40};
  }
  sensitivity(){ return RadioModel.sensitivity(this.radioCfg.sf, this.radioCfg.bwKHz, this.cfg.noiseFigureDb); }
  noiseFloor(){ return RadioModel.noiseFloorDbm(this.radioCfg.bwKHz, this.cfg.noiseFigureDb); }
  slotMs(){ return RadioModel.slotTimeMs(this.radioCfg.sf, this.radioCfg.bwKHz); }
  airtime(bytes){ return RadioModel.airtimeMs(bytes, this.radioCfg.sf, this.radioCfg.bwKHz, this.radioCfg.cr, this.cfg.preambleSym).totalMs; }
  nodeUtilPct(node){ return Math.min(100, node.util*Math.exp(-(this.timeMs-node.utilT)/60000)*100); }
  _addUtil(node, airMs){ node.util = node.util*Math.exp(-(this.timeMs-node.utilT)/60000) + airMs/60000; node.utilT=this.timeMs; }

  /* ---------- topologie ---------- */
  addNode(lat,lng,opts){ const n=new MeshNode(lat,lng,opts); this.nodes.push(n); this.links.invalidate(); this.traffic.invalidate(); return n; }
  removeNode(id){
    const n=this.nodeById(id); if(!n) return;
    const pk=n.queue.map(it=>it.packet); n.queue=[];
    this.nodes=this.nodes.filter(x=>x.id!==id);
    pk.forEach(p=>{ p.live--; this._finalize(p); });
    this.links.invalidate(); this.traffic.invalidate();
  }
  clearNodes(){ this.nodes=[]; this.links.pairs.clear(); this.reset(); this.links.invalidate(); }
  nodeMoved(n){ n.geoVer++; this.links.invalidate(); }
  setActive(n, active){
    n.active=active;
    if(!active){ const pk=n.queue.map(it=>it.packet); n.queue=[]; pk.forEach(p=>{ p.live--; this._finalize(p); }); }
    this.links.invalidate(); this.traffic.invalidate();
  }
  // puissance, gain, rôle, SF/BW : les pertes de trajet en cache restent valables, seule l'adjacence est reconstruite
  nodeParamsChanged(){ this.links.invalidate(); this.traffic.invalidate(); }
  radioChanged(){ this.links.invalidate(); this.traffic.invalidate(); }
  envChanged(){ this.links.invalidate(); }

  /* ---------- remise à zéro ---------- */
  _resetCounters(){
    this.win={generated:0, tx:0, delivered:0, dropped:0, collisions:0, retx:0, airMs:0, latSum:0, latN:0, hopSum:0, peakTx:0};
    this.totals={generated:0, tx:0, msgSent:0, msgDelivered:0, msgDropped:0, collisions:0, airMs:0, peakTx:0,
      retx:0, ackTimeouts:0, acks:0, implicitAcks:0, ackFailures:0};
    this.history={t:[], generated:[], transmitted:[], delivered:[], dropped:[], collisions:[], retx:[], airtimePct:[], latencyMs:[], hops:[], congestion:[], peakTx:[]};
  }
  reset(){
    this.q.clear(); this.timeMs=0; this.activeTx=[]; this.packets=new Map(); this.events=[]; this._detailRing=[];
    this.nodes.forEach(n=>n.resetRuntime());
    this._resetCounters();
    this._statsEvt=this.q.push(this.cfg.historyBucketMs,'STATS',null);
    this.traffic.invalidate();
  }

  log(tag,node,msg,packet,extra){
    const evt={t:this.timeMs, tag, nodeId:node?node.id:null, msg, packetId:packet?packet.id:null};
    if(extra) evt.x=extra;
    this.events.push(evt);
    if(this.events.length>this.maxEvents) this.events.splice(0, this.events.length-this.maxEvents);
    if(this.onEvent) this.onEvent(evt);
  }

  /* ---------- création de paquets ---------- */
  originate(from, to, type, sizeBytes, meta, forcedPath, opts={}){
    if(!from || !from.active) return null;
    let route='flood', presetPath=null;
    if(this.protocol==='meshcore'){
      if(forcedPath){ route='direct'; presetPath=forcedPath; }
      else if(type==='MESSAGE' && to && from.knownPaths.has(to.id)){ route='direct'; presetPath=from.knownPaths.get(to.id); }
    }
    const maxHops = type==='ADVERT_ZERO' ? 0 : this.protocol==='meshtastic' ? this.cfg.hopLimit : (route==='direct' ? presetPath.length : this.cfg.mcFloodMax);
    const p=new Packet({originId:from.id, destId:to?to.id:null, type, sizeBytes, maxHops, createdAt:this.timeMs, route, presetPath, meta, manual:opts.manual});
    this.packets.set(p.id,p);
    // le détail par nœud est gardé pour les 400 derniers paquets (et tous les paquets manuels) pour limiter la mémoire
    this._detailRing=this._detailRing||[];
    this._detailRing.push(p);
    if(this._detailRing.length>400){ const old=this._detailRing.shift(); if(!old.manual){ old.detail=null; old.txLog=null; } }
    if(this.packets.size>6000){ for(const [id,pk] of this.packets){ if(pk.live===0 && (!pk.tracker || pk.tracker.done)){ this.packets.delete(id); if(this.packets.size<=5000) break; } } }
    if(ProtocolModel.wantsAck(this,type)){
      p.tracker={packet:p, attempt:1, max:this._maxAttempts(), done:false, failed:false, ackKind:null, floodFallback:false};
    }
    from.seen.set(this._dedupKey(p,1),this.timeMs);   // l'émetteur ne relaiera jamais son propre paquet
    from.stats.generated++;
    this.win.generated++; this.totals.generated++;
    if(type==='MESSAGE') this.totals.msgSent++;
    const dest = to ? ` → ${to.label}` : '';
    const route_ = this.protocol==='meshcore' && type==='MESSAGE' ? (route==='direct' ? ` via chemin appris (${presetPath.length} répéteur(s))` : ' en flood (pas de chemin connu)') : '';
    this.log(type.startsWith('ADVERT')||type==='NODEINFO' ? 'ADVERT' : 'GEN', from, `${from.label} crée ${TYPE_LABEL[type]||type} #${p.id}${dest}${route_}${opts.manual?' [manuel]':''}`, p);
    const item={packet:p, hopsSoFar:0, pathCursor:0, relays:[], attempt:1, route, presetPath,
      notBefore:this.timeMs+ProtocolModel.originDelayMs(this,from), relay:false};
    this._enqueueOrigin(from,item);
    return p;
  }

  /* ---------- accusés de réception & renvois ---------- */
  _maxAttempts(){
    if(!this.cfg.retxEnabled) return 1;
    return this.protocol==='meshtastic' ? 3 : Math.max(1, Math.round(this.cfg.mcMaxAttempts));
  }
  // Identifiant de déduplication : Meshtastic renvoie le MÊME paquet (les nœuds qui l'ont déjà vu l'ignorent) ;
  // MeshCore crée un paquet distinct à chaque essai (le numéro d'essai change son empreinte).
  _dedupKey(p, attempt){ return this.protocol==='meshcore' ? p.id*8+((attempt||1)&7) : p.id; }

  _enqueueOrigin(from, item){
    const tr=item.packet.tracker;
    if(!this._enqueue(from,item) && tr && !tr.done){
      // file pleine : l'essai n'est jamais parti, l'application constatera l'absence d'ACK au bout du délai
      this.q.push(this.timeMs+ProtocolModel.ackTimeoutMs(this,from,item),'ACKTO',{tr, attempt:item.attempt});
    }
  }

  _ackReceived(packetId, kind){
    const p=this.packets.get(packetId); if(!p) return;
    const origin=this.nodeById(p.originId);
    if(kind==='ack' && !p.ackReceived){ p.ackReceived=true; this.totals.acks++; }
    const tr=p.tracker; if(!tr || tr.done) return;
    tr.done=true; tr.ackKind=kind;
    if(kind==='implicit'){
      this.totals.implicitAcks++;
      this.log('RETX', origin, `${origin?.label||'?'} entend un voisin relayer #${p.id} : ACK implicite, pas de renvoi`, p);
    }
    if(this.protocol==='meshcore' && origin && p.route==='direct') origin.pathFails.delete(p.destId);
    this._finalize(p);
  }

  _ackTimeout({tr, attempt}){
    if(tr.done || attempt!==tr.attempt) return;
    const p=tr.packet, from=this.nodeById(p.originId);
    this.totals.ackTimeouts++;
    const canRetry = this.cfg.retxEnabled && from && from.active && this.nodes.includes(from);
    if(canRetry && tr.attempt<tr.max){ this._resend(tr, false); return; }
    if(canRetry && this.protocol==='meshcore' && p.route==='direct' && !tr.floodFallback){
      // tous les essais par le chemin appris ont échoué : on l'oublie et on tente une dernière fois en flood
      tr.floodFallback=true;
      from.knownPaths.delete(p.destId); from.pathFails.delete(p.destId);
      this.log('PATH', from, `${from.label} : ${tr.attempt} essai(s) sans ACK par le chemin appris vers ${this.nodeById(p.destId)?.label||'?'} — chemin oublié, renvoi en flood`, p);
      this._resend(tr, true); return;
    }
    tr.done=true; tr.failed=true; this.totals.ackFailures++;
    p.lossReasons.no_ack=(p.lossReasons.no_ack||0)+1;
    this.log('RETX', from, `${from?.label||'?'} : aucun ACK pour #${p.id} après ${tr.attempt} envoi(s) — échec signalé à l'utilisateur`, p);
    this._finalize(p);
  }

  _resend(tr, forceFlood){
    const p=tr.packet, from=this.nodeById(p.originId), to=p.destId!==null?this.nodeById(p.destId):null;
    tr.attempt++;
    let route='flood', presetPath=null;
    if(this.protocol==='meshcore' && !forceFlood && to && from.knownPaths.has(to.id)){ route='direct'; presetPath=from.knownPaths.get(to.id); }
    p.route=route; p.presetPath=presetPath;
    from.stats.retx++; this.win.retx++; this.totals.retx++;
    from.seen.set(this._dedupKey(p,tr.attempt),this.timeMs);
    const label = forceFlood ? 'essai en flood' : `essai ${tr.attempt}/${tr.max}`;
    this.log('RETX', from, `${from.label} : pas d'ACK pour #${p.id} — renvoi (${label}${this.protocol==='meshcore'?(route==='direct'?', chemin appris':', flood'):''})`, p);
    this._enqueueOrigin(from, {packet:p, hopsSoFar:0, pathCursor:0, relays:[], attempt:tr.attempt, route, presetPath,
      notBefore:this.timeMs+ProtocolModel.originDelayMs(this,from), relay:false});
  }

  _enqueue(node,item){
    const p=item.packet;
    if(node.queue.length>=this.cfg.queueMax){
      node.stats.queueDrops++;
      p.lossReasons.queue_full=(p.lossReasons.queue_full||0)+1;
      this.log('DROP', node, `${node.label} : file d'émission pleine (${this.cfg.queueMax}) — paquet #${p.id} abandonné`, p);
      this._finalize(p);
      return false;
    }
    p.live++;
    node.queue.push(item);
    node.stats.queueMax=Math.max(node.stats.queueMax,node.queue.length);
    this._scheduleTx(node,item.notBefore);
    return true;
  }

  _cancelRelay(node, packet){
    const idx=node.queue.findIndex(it=>it.packet===packet && it.relay);
    if(idx<0) return false;
    node.queue.splice(idx,1);
    node.stats.suppressed++;
    this._noteRelay(packet,node.id,'cancelled');
    packet.live--;
    this.log('SUPPR', node, `${node.label} annule son relais du paquet #${packet.id} — doublon entendu (managed flooding)`, packet);
    this._finalize(packet);
    return true;
  }

  _finalize(p){
    if(p.live>0 || p.status==='delivered' || p.status==='dropped' || p.status==='done') return;
    if(p.tracker && !p.tracker.done) return;   // l'émetteur attend encore un ACK et peut renvoyer
    if(p.destId===null){ p.status='done'; return; }
    p.status='dropped';
    const origin=this.nodeById(p.originId);
    if(origin) origin.stats.dropped++;
    this.win.dropped++;
    if(p.type==='MESSAGE') this.totals.msgDropped++;
    const reasons=Object.entries(p.lossReasons).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k])=>LOSS_LABEL[k]||k).join(', ');
    this.log('DROP', origin, `Paquet #${p.id} (${TYPE_LABEL[p.type]||p.type}) jamais livré${reasons?' — '+reasons:''}`, p);
    ProtocolModel.onFailed(this,p);
  }

  /* ---------- émission ---------- */
  _scheduleTx(node,t){
    t=Math.max(t,this.timeMs);
    if(node._txEvt && !node._txEvt.cancelled){
      if(node._txEvt.t<=t) return;
      node._txEvt.cancelled=true;
    }
    node._txEvt=this.q.push(t,'TX',node);
  }

  _channelBusy(node){
    const sens=this.sensitivity(), detectMs=2*RadioModel.symbolMs(this.radioCfg.sf,this.radioCfg.bwKHz);
    for(const o of this.activeTx){
      if(o.node===node) return true;
      if(this.timeMs-o.start < detectMs) continue;     // préambule pas encore détectable (fenêtre de vulnérabilité)
      const r=this.links.rssiOf(o.node.id,node.id);
      if(r!==null && r>=sens) return true;
    }
    return false;
  }

  dutyUsage(node){
    const win=this.cfg.dutyWindowMs, now=this.timeMs;
    while(node.txWindow.length && now-node.txWindow[0].t>=win) node.txWindow.shift();
    return node.txWindow.reduce((s,e)=>s+e.dur,0);
  }

  _txAttempt(node){
    node._txEvt=null;
    if(!node.active || !node.queue.length || !this.nodes.includes(node)) return;
    const now=this.timeMs;
    if(node.txUntil>now){ this._scheduleTx(node,node.txUntil); return; }
    let idx=0;
    for(let i=1;i<node.queue.length;i++) if(node.queue[i].notBefore<node.queue[idx].notBefore) idx=i;
    const item=node.queue[idx], p=item.packet;
    if(item.notBefore>now){ this._scheduleTx(node,item.notBefore); return; }

    // écoute avant émission
    if(this._channelBusy(node)){
      node.stats.cadBusy++;
      if(this.protocol==='meshtastic'){
        // RadioLibInterface : canal occupé → nouveau délai aléatoire (pondéré SNR pour un relais)
        item.notBefore = now + (item.relay ? ProtocolModel.relayDelayMs(this,node,item) : ProtocolModel.originDelayMs(this,node)) + 1;
      } else {
        // Dispatcher MeshCore : nouvel essai 200 ms plus tard, émission forcée après 4 s d'occupation
        item.cadSince = item.cadSince ?? now;
        if(now-item.cadSince<=4000) item.notBefore = now + 200;
      }
      if(item.notBefore>now){ this._scheduleTx(node,item.notBefore); return; }
    } else item.cadSince = null;

    const bytes=ProtocolModel.onAirBytes(this,item), air=this.airtime(bytes);
    const prof=REG_PROFILES[this.regProfile];
    const used=this.dutyUsage(node);
    node.currentDutyPct=used/this.cfg.dutyWindowMs;
    if(prof.dutyCycle){
      const limit=prof.dutyCycle*this.cfg.dutyWindowMs;
      if(used+air>limit){
        let need=used+air-limit, wait=now+1000;
        for(const e of node.txWindow){ need-=e.dur; if(need<=0){ wait=e.t+this.cfg.dutyWindowMs+1; break; } }
        node.dutyState='over';
        if(now-node._dutyLogged>30000){ node._dutyLogged=now; this.log('DUTY', node, `${node.label} : émission différée — duty cycle ${(node.currentDutyPct*100).toFixed(2)} % / ${(prof.dutyCycle*100)} % sur 1 h`, p); }
        this._scheduleTx(node,wait); return;
      }
      node.dutyState = (used+air)>limit*0.75 ? 'warn' : 'ok';
    }

    // début d'émission
    node.queue.splice(idx,1);
    const tx={id:_txSeq++, node, item, start:now, end:now+air, air, bytes, rx:new Map()};
    node.txUntil=tx.end;
    node.txWindow.push({t:now, dur:air});
    node.stats.tx++; node.stats.airtimeMs+=air;
    if(item.relay){ node.stats.relayed++; p.relayers.add(node.id); this._noteRelay(p,node.id,'relayed'); }
    else if(p.tracker && !p.tracker.done && item.attempt===p.tracker.attempt){
      // le compte à rebours de l'ACK démarre quand l'essai part réellement sur les ondes
      this.q.push(now+ProtocolModel.ackTimeoutMs(this,node,item),'ACKTO',{tr:p.tracker, attempt:item.attempt});
    }
    p.txCount++;
    this.win.tx++; this.win.airMs+=air; this.totals.tx++; this.totals.airMs+=air;
    this._addUtil(node,air);

    // l'émetteur perd ce qu'il était en train de recevoir (demi-duplex)
    for(const o of this.activeTx){ const r=o.rx.get(node.id); if(r && !r.lost) r.lost='half_duplex'; }

    const sigma=this.cfg.fadingSigmaDb, sens=this.sensitivity();
    for(const nb of this.links.neighbors(node)){
      const r=nb.node; if(!r.active) continue;
      if(nb.rssi>=sens) this._addUtil(r,air);
      if(!nb.reachable) continue;
      const fade = sigma>0 ? gaussian()*sigma : 0;
      const rec={rssi:nb.rssi+fade, snr:nb.snr+fade, interfMw:0, lost:null};
      if(rec.rssi<sens) rec.lost='weak';
      else if(r.txUntil>now) rec.lost='half_duplex';
      tx.rx.set(r.id,rec);
    }
    // interférences croisées avec les émissions en cours (même canal, même SF)
    for(const o of this.activeTx){
      for(const [rid,rec] of tx.rx){ const pw=this.links.rssiOf(o.node.id,rid); if(pw!==null) rec.interfMw+=dbmToMw(pw); }
      for(const [rid,rec] of o.rx){ const pw=this.links.rssiOf(node.id,rid); if(pw!==null) rec.interfMw+=dbmToMw(pw); }
    }
    this.activeTx.push(tx);
    this.win.peakTx=Math.max(this.win.peakTx,this.activeTx.length);
    this.totals.peakTx=Math.max(this.totals.peakTx,this.activeTx.length);
    this.q.push(tx.end,'TXEND',tx);
    if(item.relay) this.log('TX', node, `${node.label} relaie #${p.id} (${bytes} o, ${air.toFixed(0)} ms, saut ${item.hopsSoFar})`, p);
    else this.log('TX', node, `${node.label} émet #${p.id} (${bytes} o, ${air.toFixed(0)} ms)`, p);
    if(this.onTxStart) this.onTxStart(tx);
  }

  _txEnd(tx){
    const i=this.activeTx.indexOf(tx); if(i>=0) this.activeTx.splice(i,1);
    const p=tx.item.packet, cap=this.cfg.captureDb, key=this._dedupKey(p,tx.item.attempt);
    let collided=false;
    // bilan de cette émission : qui l'a décodée pour la 1re fois, qui l'avait déjà, qui l'a perdue
    const sum={t:tx.start, from:tx.node.id, relay:tx.item.relay, hops:tx.item.hopsSoFar, attempt:tx.item.attempt, air:tx.air, ok:[], dup:[], lost:[]};
    for(const [rid,rec] of tx.rx){
      const r=this.nodeById(rid); if(!r || !r.active){ rec.lost=rec.lost||'gone'; continue; }
      if(!rec.lost && rec.interfMw>0 && rec.rssi-10*Math.log10(rec.interfMw)<cap) rec.lost='collision';
      const already=r.seen.has(key);
      if(rec.lost){
        // "utile" = le récepteur n'avait pas encore ce paquet ; les doublons perdus ne comptent pas comme pertes réseau
        const useful=!already;
        if(rec.lost==='collision'){ r.stats.collisions++; if(useful) collided=true; }
        else if(rec.lost==='half_duplex') r.stats.halfDuplex++;
        else if(rec.lost==='weak') r.stats.weak++;
        if(useful){
          p.lossReasons[rec.lost]=(p.lossReasons[rec.lost]||0)+1;
          sum.lost.push([rid,rec.lost]);
          this._noteRx(p, rid, rec.lost, tx, rec);
        } else sum.dup.push(rid);
        continue;
      }
      (already?sum.dup:sum.ok).push(rid);
      this._noteRx(p, rid, already?'dup':'ok', tx, rec);
      this._receive(r,tx,rec);
    }
    // une émission "en collision" = au moins un récepteur qui n'avait pas encore le paquet l'a perdu
    if(collided){ this.win.collisions++; this.totals.collisions++; }
    if(tx.rx.size===0) p.lossReasons.no_neighbor=(p.lossReasons.no_neighbor||0)+1;
    if(p.txLog){ p.txLog.push(sum); if(p.txLog.length>300) p.txLog.shift(); }
    this._logReception(tx, p, sum);
    if(this.onTxEnd) this.onTxEnd(tx);
    p.live--;
    this._finalize(p);
    if(tx.node.queue.length) this._scheduleTx(tx.node,this.timeMs);
  }

  // Détail par nœud (conservé pour les derniers paquets) : 1re réception, doublons, pertes, décision de relais
  _noteRx(p, id, st, tx, rec){
    if(!p.detail) return;
    let d=p.detail.get(id);
    if(!d){ d={st:null, t:null, from:null, hops:null, rssi:null, dups:0, lost:{}, relay:null}; p.detail.set(id,d); }
    if(st==='ok'){ d.st='ok'; d.t=this.timeMs; d.from=tx.node.id; d.hops=tx.item.hopsSoFar; d.rssi=rec.rssi; }
    else if(st==='dup') d.dups++;
    else d.lost[st]=(d.lost[st]||0)+1;
  }
  _noteRelay(p, id, state){ const d=p.detail&&p.detail.get(id); if(d) d.relay=state; }

  _logReception(tx, p, sum){
    const nm=id=>this.nodeById(id)?.label||('#'+id);
    const list=(ids,max=8)=>ids.slice(0,max).map(nm).join(', ')+(ids.length>max?` +${ids.length-max}`:'');
    const why={collision:'collision', half_duplex:'en émission', weak:'trop faible'};
    // nœuds actifs qui n'ont même pas capté le signal (hors de portée), avec leur marge nominale
    const heard=new Set(tx.rx.keys()), outIds=[];
    for(const n of this.nodes) if(n!==tx.node && n.active && !heard.has(n.id)) outIds.push(n.id);
    const parts=[];
    if(sum.ok.length) parts.push(`reçu par ${list(sum.ok)}`);
    if(sum.lost.length) parts.push(`perdu par ${sum.lost.slice(0,6).map(([id,w])=>`${nm(id)} (${why[w]||w})`).join(', ')}${sum.lost.length>6?` +${sum.lost.length-6}`:''}`);
    if(sum.dup.length) parts.push(`${sum.dup.length} l'avai${sum.dup.length>1?'en':''}t déjà`);
    if(outIds.length) parts.push(`hors de portée : ${list(outIds)}`);
    if(!sum.ok.length && !sum.lost.length && !sum.dup.length) parts.unshift('personne ne l’a reçu');
    // détail structuré pour l'affichage en pastilles colorées (plafonné pour les gros réseaux)
    const sens=this.sensitivity(), CAP=40;
    const nominal=id=>{ const v=this.links.rssiOf(tx.node.id,id); return v===null ? null : v-sens; };
    const rx=[];
    sum.ok.slice(0,CAP).forEach(id=>rx.push({id, st:'ok', m:nominal(id)}));
    sum.lost.slice(0,CAP).forEach(([id,w])=>rx.push({id, st:'lost', why:w, m:nominal(id)}));
    const outShown=outIds.length<=25 ? outIds : [];
    outShown.forEach(id=>{ const n=this.nodeById(id); rx.push({id, st:'out', m:n?this.links.margin(tx.node,n):null}); });
    this.log('RX', tx.node, `${tx.node.label} ${tx.item.relay?'relaie':'émet'} #${p.id} → ${parts.join(' · ')}`, p,
      {rx, okMore:Math.max(0,sum.ok.length-CAP), lostMore:Math.max(0,sum.lost.length-CAP), dup:sum.dup.length, outMore:outIds.length-outShown.length, relay:tx.item.relay});
  }

  _receive(node,tx,rec){
    const item=tx.item, p=item.packet, key=this._dedupKey(p,item.attempt);
    node.stats.rx++;
    // Meshtastic : l'émetteur qui entend un voisin relayer son paquet le considère comme acquitté (ACK implicite)
    if(this.protocol==='meshtastic' && item.relay && p.originId===node.id && p.tracker && !p.tracker.done) this._ackReceived(p.id,'implicit');
    if(node.seen.has(key)){
      node.stats.dupes++;
      if(ProtocolModel.cancelsOnDuplicate(this,node)) this._cancelRelay(node,p);
      // un renvoi reçu par un destinataire qui a déjà le message : il renvoie un ACK (le précédent a pu se perdre)
      if(p.destId===node.id && p.tracker && item.attempt>p.ackedAttempt) ProtocolModel.sendAck(this,node,p,item);
      return;
    }
    node.seen.set(key,this.timeMs);
    if(node.seen.size>3000){ const it=node.seen.keys(); for(let k=0;k<500;k++) node.seen.delete(it.next().value); }
    p.reached.add(node.id);

    if(p.destId===node.id){ this._noteRelay(p,node.id,'destinataire'); this._deliver(node,item); return; }  // on ne relaie pas un paquet qui nous est adressé

    const d=ProtocolModel.relayDecision(this,node,item);
    if(!d.relay){ p.lossReasons[d.reason]=(p.lossReasons[d.reason]||0)+1; this._noteRelay(p,node.id,'no:'+d.reason); return; }
    this._noteRelay(p,node.id,'planned');
    const next={packet:p, hopsSoFar:item.hopsSoFar+1, pathCursor:item.pathCursor+(d.mode==='direct'?1:0),
      relays:item.relays.concat(node.id), rxSnr:rec.snr, relay:true, notBefore:0,
      attempt:item.attempt, route:item.route, presetPath:item.presetPath};
    const delay=ProtocolModel.relayDelayMs(this,node,next);
    next.notBefore=this.timeMs+delay;
    if(this._enqueue(node,next)){
      this.log('RELAY', node, `${node.label} programme le relais de #${p.id} dans ${delay.toFixed(0)} ms (SNR ${rec.snr.toFixed(1)} dB, ${d.mode==='direct'?'chemin appris':'flood'})`, p);
    } else this._noteRelay(p,node.id,'no:queue_full');
  }

  _deliver(node,item){
    const p=item.packet;
    if(p.status==='delivered'){
      // MeshCore : un nouvel essai est un paquet distinct, reçu comme neuf → nouvel ACK pour cet essai
      if(p.tracker && item.attempt>p.ackedAttempt) ProtocolModel.sendAck(this,node,p,item);
      return;
    }
    p.status='delivered'; p.deliveredAt=this.timeMs; p.deliveredHops=item.hopsSoFar;
    p.deliveredPath=[p.originId, ...item.relays, node.id];
    node.stats.delivered++;
    this.win.delivered++;
    const lat=p.deliveredAt-p.createdAt;
    if(p.type==='MESSAGE'){ this.totals.msgDelivered++; this.win.latSum+=lat; this.win.latN++; this.win.hopSum+=item.hopsSoFar; }
    this.log('DELIVERED', node, `#${p.id} (${TYPE_LABEL[p.type]||p.type}) livré à ${node.label} après ${item.hopsSoFar} relais, ${(lat/1000).toFixed(2)} s`, p);
    ProtocolModel.onDelivered(this,node,p,item);
  }

  /* ---------- boucle ---------- */
  // avance le temps simulé de dtMs ; renvoie false si la table des liaisons est encore en calcul
  advance(dtMs, maxEvents=40000){
    if(!this.links.work(20)) return false;
    if(this.traffic.dirty) this.traffic.rebuild();
    if(!this._statsEvt) this._statsEvt=this.q.push(this.timeMs+this.cfg.historyBucketMs,'STATS',null);
    const target=this.timeMs+dtMs;
    let n=0;
    while(this.q.size && this.q.peek().t<=target){
      const e=this.q.pop();
      if(e.cancelled) continue;
      this.timeMs=e.t;
      switch(e.type){
        case 'TX': this._txAttempt(e.data); break;
        case 'TXEND': this._txEnd(e.data); break;
        case 'GEN': this.traffic.fire(e.data); break;
        case 'ACKTO': this._ackTimeout(e.data); break;
        case 'STATS': this._pushHistory(); this._statsEvt=this.q.push(this.timeMs+this.cfg.historyBucketMs,'STATS',null); break;
      }
      if(++n>=maxEvents) return true;
      if(this.links.dirty) return true;
    }
    this.timeMs=target;
    return true;
  }

  _pushHistory(){
    const B=this.cfg.historyBucketMs/1000, w=this.win;
    const active=this.nodes.filter(n=>n.active);
    const avgUtil = active.length ? active.reduce((s,n)=>s+this.nodeUtilPct(n),0)/active.length : 0;
    const avgQueue = active.length ? active.reduce((s,n)=>s+n.queue.length,0)/active.length : 0;
    const h=this.history;
    h.t.push(this.timeMs/1000);
    h.generated.push(w.generated/B); h.transmitted.push(w.tx/B); h.delivered.push(w.delivered/B);
    h.dropped.push(w.dropped/B); h.collisions.push(w.collisions/B); h.retx.push(w.retx/B);
    h.airtimePct.push(avgUtil);
    h.latencyMs.push(w.latN? w.latSum/w.latN : null);
    h.hops.push(w.latN? w.hopSum/w.latN : null);
    h.congestion.push(Math.min(100, avgQueue/this.cfg.queueMax*100*0.6 + avgUtil*0.8));
    h.peakTx.push(w.peakTx);
    const cap=360;
    Object.keys(h).forEach(k=>{ if(h[k].length>cap) h[k].splice(0,h[k].length-cap); });
    this.win={generated:0, tx:0, delivered:0, dropped:0, collisions:0, retx:0, airMs:0, latSum:0, latN:0, hopSum:0, peakTx:this.activeTx.length};
    if(this.onStats) this.onStats();
  }

  totalStats(){
    const s={tx:0,rx:0,relayed:0,delivered:0,collisions:0,airtimeMs:0,dropped:0,suppressed:0};
    this.nodes.forEach(n=>{ for(const k in s) s[k]+=n.stats[k]||0; });
    return s;
  }
}

/* ---------------------------------------------------------------------
   COMPARATEUR — modèle analytique (statistique, pas géographique)
   Explicitement [Estimation] : hypothèses de densité et de comportement
   moyen ; la simulation nœud par nœud est dans l'onglet Simulateur.
--------------------------------------------------------------------- */
const ComparatorModel = {
  avgDegree(n, areaKm2, rangeKm){
    const deg=(n/areaKm2)*Math.PI*rangeKm*rangeKm;
    return Math.max(0.6, Math.min(deg, n-1));
  },
  run(n, opts){
    const areaKm2=opts.areaKm2??25, rangeKm=opts.rangeKm??3.2, repeaterRatio=opts.repeaterRatio??0.12;
    const hopLimit=opts.hopLimit??3, sizeBytes=opts.sizeBytes??45, durationMin=opts.durationMin??60, msgIntervalMin=opts.msgIntervalMin??10;
    const suppressionFactor=opts.suppressionFactor??0.5, meshcoreRepeatShare=opts.meshcoreRepeatShare??0.75;
    const deg=this.avgDegree(n,areaKm2,rangeKm);
    const nRepeaters=Math.max(1,Math.round(n*repeaterRatio));
    const airtime=RadioModel.airtimeMs(sizeBytes, opts.sf??11, opts.bwKHz??250, 1).totalMs;
    const messagesTotal=Math.round(n*(durationMin/msgIntervalMin));
    let hopReach=1;
    for(let h=0;h<hopLimit;h++) hopReach=Math.min(n-1, hopReach+hopReach*deg*0.55);
    const mtTransmissionsPerMsg=1+hopReach*(1-suppressionFactor);
    const floodMax=Math.min(hopLimit,3);
    let repHopReach=1;
    for(let h=0;h<floodMax;h++) repHopReach=Math.min(nRepeaters, repHopReach+repHopReach*(deg*repeaterRatio)*0.55+0.3);
    const avgPathHops=Math.max(1, Math.min(hopLimit, Math.log2(Math.max(2,n/8))));
    const discoveryTx=Math.max(1, repHopReach*0.6);
    const mcTransmissionsPerMsg=meshcoreRepeatShare*avgPathHops+(1-meshcoreRepeatShare)*discoveryTx;
    const channelMs=durationMin*60*1000;
    const mtChannelPct=Math.min(100, messagesTotal*mtTransmissionsPerMsg*airtime/channelMs*100);
    const mcChannelPct=Math.min(100, messagesTotal*mcTransmissionsPerMsg*airtime/channelMs*100);
    const deliveryCurve=pct=>1/(1+Math.exp((pct-55)/12));
    return {
      n, avgDegree:deg, messagesTotal,
      meshtastic:{transmissionsPerMsg:mtTransmissionsPerMsg, totalTx:Math.round(messagesTotal*mtTransmissionsPerMsg), channelPct:mtChannelPct, deliveryPct:Math.max(0.05,deliveryCurve(mtChannelPct))*100},
      meshcore:{transmissionsPerMsg:mcTransmissionsPerMsg, totalTx:Math.round(messagesTotal*mcTransmissionsPerMsg), channelPct:mcChannelPct, deliveryPct:Math.max(0.05,deliveryCurve(mcChannelPct))*100, avgPathHops}
    };
  }
};
