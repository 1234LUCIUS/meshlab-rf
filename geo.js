/* =========================================================================
   MeshLab RF — Données géographiques & propagation radio
   ---------------------------------------------------------------------
   Sources de données réelles (vérifiées accessibles en CORS depuis un
   navigateur, sans clé API) :
   - Relief, France et DOM (source par défaut) : IGN Géoplateforme, RGE
     ALTI® servi en tuiles WMTS BIL float32 — data.geopf.fr/wmts, couche
     ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES. C'est un modèle numérique de
     TERRAIN : sol nu, sans arbres ni bâtiments. ~19 m (z12) ou ~9,5 m (z13).
   - Relief, reste du monde (et zones trop vastes pour l'IGN) : AWS Terrain
     Tiles, encodage "Terrarium" (SRTM 1" ~30 m en Europe, complété
     GMTED/ETOPO) — s3.amazonaws.com/elevation-tiles-prod. NB : SRTM est un
     modèle numérique de SURFACE partiel (bande C) : il intègre en partie la
     canopée et le bâti, contrairement au RGE ALTI.
   - Profil haute précision à la demande (France) : IGN Géoplateforme
     (data.geopf.fr/altimetrie, RGE ALTI 1 m) — inspecteur de liaison.
   - Occupation du sol : OpenStreetMap via Overpass API (forêts / bois,
     zones bâties : landuse residential/commercial/industrial/retail).
   Modèles de propagation :
   - Espace libre (Friis) + courbure terrestre (rayon effectif k = 4/3).
   - Diffraction relief : on retient la plus forte de deux estimations —
     Deygout limité à 3 arêtes (crêtes distinctes), et obstacle équivalent
     de Bullington + correction d'obstacle arrondi T(m,n) de l'ITU-R P.526
     (collines et plateaux larges, que les lames de couteau sous-estiment ;
     rayon estimé par la largeur de l'obstacle / l'angle de diffraction).
   - Réflexion sol : modèle terre plane à 2 rayons (40·log d au-delà de
     la distance de rupture), hauteurs effectives au-dessus du relief
     moyen ; on retient max(diffraction, réflexion sol).
   - Perte de clutter aux terminaux : ITU-R P.2108 §3.1 (height-gain).
   - Traversée de végétation : ITU-R P.833 (atténuation excédentaire
     saturante A = Am·(1−exp(−d·γ/Am)), Am = 0,18·f^0,752).
   Tout ce qui relève du clutter est étiqueté [Estimation].
   ========================================================================= */

const Geo = {
  R: 6371000,
  toRad(d){ return d*Math.PI/180; },
  distanceM(a,b){
    const dLat=this.toRad(b.lat-a.lat), dLon=this.toRad(b.lng-a.lng);
    const la1=this.toRad(a.lat), la2=this.toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return 2*this.R*Math.asin(Math.min(1,Math.sqrt(h)));
  },
  destPoint(lat,lng,bearingDeg,distM){
    const br=this.toRad(bearingDeg);
    const la1=this.toRad(lat), lo1=this.toRad(lng);
    const dR=distM/this.R;
    const la2=Math.asin(Math.sin(la1)*Math.cos(dR)+Math.cos(la1)*Math.sin(dR)*Math.cos(br));
    const lo2=lo1+Math.atan2(Math.sin(br)*Math.sin(dR)*Math.cos(la1),Math.cos(dR)-Math.sin(la1)*Math.sin(la2));
    return {lat: la2*180/Math.PI, lng: lo2*180/Math.PI};
  },
  // Web Mercator : coordonnées "pixel monde" au zoom z (tuiles de 256 px)
  project(lat,lng,z){
    const s = 256*Math.pow(2,z);
    const sin = Math.sin(this.toRad(Math.max(-85.0511, Math.min(85.0511, lat))));
    return { x:(lng+180)/360*s, y:(0.5 - Math.log((1+sin)/(1-sin))/(4*Math.PI))*s };
  },
  metersPerPixel(lat,z){ return 156543.03392*Math.cos(this.toRad(lat))/Math.pow(2,z); },
  bboxOf(points, marginM=300){
    if(!points.length) return null;
    let s=90,n=-90,w=180,e=-180;
    points.forEach(p=>{ s=Math.min(s,p.lat); n=Math.max(n,p.lat); w=Math.min(w,p.lng); e=Math.max(e,p.lng); });
    const dLat = marginM/111320, dLng = marginM/(111320*Math.cos(this.toRad((s+n)/2)));
    return {s:s-dLat, n:n+dLat, w:w-dLng, e:e+dLng};
  },
  bboxAreaKm2(b){
    const h = (b.n-b.s)*111.32, w = (b.e-b.w)*111.32*Math.cos(this.toRad((b.s+b.n)/2));
    return Math.abs(h*w);
  },
  bboxContains(outer, inner){
    return !!outer && !!inner && inner.s>=outer.s && inner.n<=outer.n && inner.w>=outer.w && inner.e<=outer.e;
  }
};

/* ---------------------------------------------------------------------
   MNT RÉEL — tuiles Terrarium (AWS Terrain Tiles)
   élévation = (R·256 + G + B/256) − 32768   (mètres)
--------------------------------------------------------------------- */
class TerrariumDEM{
  constructor(){
    this.id = 'real';
    this.name = 'SRTM ~30 m (AWS Terrain Tiles / Terrarium)';
    this.z = 12;
    this.maxTiles = 144;         // ≈ 80×80 km à z12 sous nos latitudes ; au-delà on descend en zoom
    this.grid = new Map();       // clé numérique (x*65536+y) → Float32Array(65536) | null (échec)
    this.inflight = new Map();
    this.version = 0;
    this.failedTiles = 0;
    this.failedAt = new Map();   // tuile en échec → instant de l'échec (nouvel essai après retryMs)
    this.retryMs = 30000;
    this._lastKey = -1; this._lastTile = null;
  }
  // tuile absente, ou en échec depuis assez longtemps pour retenter
  _needsLoad(key){
    if(!this.grid.has(key)) return true;
    if(this.grid.get(key)) return false;
    return Date.now()-(this.failedAt.get(key)||0) > this.retryMs;
  }
  // nombre de tuiles de la zone dont l'altitude est indisponible (échec de téléchargement)
  missingTiles(b){
    if(!b) return 0;
    const r=this._tileRange(b,this.z); let n=0;
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++){ const k=x*65536+y; if(!this.grid.has(k) || !this.grid.get(k)) n++; }
    return n;
  }
  get resolutionM(){ return Geo.metersPerPixel(46, this.z); }
  _tileRange(b, z){
    const p1=Geo.project(b.n,b.w,z), p2=Geo.project(b.s,b.e,z);
    return {x0:Math.floor(p1.x/256), x1:Math.floor(p2.x/256), y0:Math.floor(p1.y/256), y1:Math.floor(p2.y/256)};
  }
  _count(r){ return (r.x1-r.x0+1)*(r.y1-r.y0+1); }
  chooseZoom(b){
    for(let z=12; z>=8; z--){ if(this._count(this._tileRange(b,z))<=this.maxTiles) return z; }
    return 8;
  }
  covers(b){
    if(!b) return true;
    if(this.chooseZoom(b)!==this.z) return false;
    const r=this._tileRange(b,this.z);
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++) if(this._needsLoad(x*65536+y)) return false;
    return true;
  }
  async ensure(b, onProgress){
    if(!b) return {loaded:0, failed:0};
    const z = this.chooseZoom(b);
    if(z!==this.z){ this.z=z; this.grid.clear(); this._lastKey=-1; this._lastTile=null; this.version++; }
    const r=this._tileRange(b,z);
    const todo=[];
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++) if(this._needsLoad(x*65536+y)) todo.push([x,y]);
    if(!todo.length) return {loaded:0, failed:0};
    let done=0, failed=0;
    const worker = async()=>{
      while(todo.length){
        const [x,y]=todo.shift();
        const ok = await this._load(z,x,y);
        if(!ok) failed++;
        done++; if(onProgress) onProgress(done, done+todo.length);
      }
    };
    await Promise.all([worker(),worker(),worker(),worker(),worker(),worker()]);
    this.failedTiles += failed;
    this.version++;
    return {loaded:done-failed, failed};
  }
  _load(z,x,y){
    const key=x*65536+y;
    if(this.inflight.has(key)) return this.inflight.get(key);
    const pr = new Promise(resolve=>{
      const n=Math.pow(2,z);
      if(y<0||y>=n){ this.grid.set(key,null); this.failedAt.set(key,Date.now()); resolve(false); return; }
      const img=new Image();
      img.crossOrigin='anonymous';
      img.onload=()=>{
        try{
          const c=document.createElement('canvas'); c.width=256; c.height=256;
          const ctx=c.getContext('2d',{willReadFrequently:true});
          ctx.drawImage(img,0,0);
          const d=ctx.getImageData(0,0,256,256).data;
          const arr=new Float32Array(65536);
          for(let i=0,j=0;i<65536;i++,j+=4) arr[i]=(d[j]*256 + d[j+1] + d[j+2]/256) - 32768;
          if(z===this.z){ this.grid.set(key,arr); this._lastKey=-1; this._lastTile=null; }
          resolve(true);
        }catch(e){ this.grid.set(key,null); this.failedAt.set(key,Date.now()); resolve(false); }
      };
      img.onerror=()=>{ this.grid.set(key,null); this.failedAt.set(key,Date.now()); this._lastKey=-1; this._lastTile=null; resolve(false); };
      img.src=`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${((x%n)+n)%n}/${y}.png`;
    });
    const wrapped = pr.then(v=>{ this.inflight.delete(key); return v; });
    this.inflight.set(key, wrapped);
    return wrapped;
  }
  _px(X,Y){
    const tx=X>>8, ty=Y>>8, key=tx*65536+ty;
    let t;
    if(key===this._lastKey) t=this._lastTile;
    else { t=this.grid.get(key); this._lastKey=key; this._lastTile=t; }
    if(!t) return NaN;
    return t[((Y-(ty<<8))<<8) + (X-(tx<<8))];
  }
  sampleWorldPx(px,py){
    const fx=px-0.5, fy=py-0.5, x0=Math.floor(fx), y0=Math.floor(fy), tx=fx-x0, ty=fy-y0;
    const v00=this._px(x0,y0), v10=this._px(x0+1,y0), v01=this._px(x0,y0+1), v11=this._px(x0+1,y0+1);
    const v = (v00*(1-tx)+v10*tx)*(1-ty) + (v01*(1-tx)+v11*tx)*ty;
    if(!Number.isNaN(v)) return v;
    // bord de tuile manquante : valeur la plus proche disponible
    for(const c of [v00,v10,v01,v11]) if(!Number.isNaN(c)) return c;
    return NaN;
  }
  elevation(lat,lng){ const p=Geo.project(lat,lng,this.z); return this.sampleWorldPx(p.x,p.y); }
  lineSampler(a,b){
    const p0=Geo.project(a.lat,a.lng,this.z), p1=Geo.project(b.lat,b.lng,this.z);
    const dx=p1.x-p0.x, dy=p1.y-p0.y;
    return t=>this.sampleWorldPx(p0.x+dx*t, p0.y+dy*t);
  }
}

/* ---------------------------------------------------------------------
   MNT IGN RGE ALTI — tuiles WMTS BIL float32 (data.geopf.fr, sans clé)
   Modèle numérique de TERRAIN (sol nu, sans arbres ni bâtiments), issu
   du RGE ALTI® 1 m rééchantillonné. Couverture : France et DOM.
   Grille géographique WGS84G_6_14 : une tuile de 256×256 pixels couvre
   180/2^z degrés en latitude comme en longitude.
   Résolution : ~19 m au zoom 12, ~9,5 m au zoom 13 (SRTM : ~26 m).
--------------------------------------------------------------------- */
const IGN_COVERAGE = [
  {name:'France métropolitaine',    s: 41.30, n: 51.15, w: -5.25, e:  9.70},
  {name:'Guadeloupe',               s: 15.80, n: 16.55, w:-61.85, e:-60.95},
  {name:'Martinique',               s: 14.35, n: 14.92, w:-61.25, e:-60.75},
  {name:'Guyane',                   s:  2.05, n:  5.85, w:-54.65, e:-51.55},
  {name:'La Réunion',               s:-21.42, n:-20.82, w: 55.15, e: 55.90},
  {name:'Mayotte',                  s:-13.05, n:-12.60, w: 44.95, e: 45.35},
  {name:'Saint-Pierre-et-Miquelon', s: 46.70, n: 47.20, w:-56.55, e:-56.10}
];
// les Float32Array lisent la mémoire dans l'ordre de la machine ; le BIL de l'IGN est petit-boutiste
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

class IgnDEM{
  constructor(){
    this.id='ign';
    this.name='IGN RGE ALTI (MNT sol nu)';
    this.z=12; this.zMin=11; this.zMax=13;
    this.maxTiles=40;            // ≈ 8 Mo de tuiles ; au-delà la zone repasse au SRTM
    this.nodataMax=0.35;         // au-delà (mer, frontière) la tuile est jugée inexploitable
    this.grid=new Map();         // clé x*65536+y → Float32Array(65536) | null (échec)
    this.inflight=new Map();
    this.version=0;
    this.failedTiles=0;
    this.failedAt=new Map();
    this.retryMs=30000;
    this.outside=new Set();      // "z:x:y" hors couverture IGN — jamais retenté
    this._lastKey=-1; this._lastTile=null;
  }
  static url(z,x,y){
    return 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
      + '&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLE=normal&TILEMATRIXSET=WGS84G_6_14'
      + '&FORMAT=image/x-bil;bits=32'
      + `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  }
  get resolutionM(){ return 111320*180/(Math.pow(2,this.z)*256); }
  _span(z){ return 180/Math.pow(2,z); }
  _tileRange(b,z){
    const sp=this._span(z);
    return {x0:Math.floor((b.w+180)/sp), x1:Math.floor((b.e+180)/sp),
            y0:Math.floor((90-b.n)/sp),  y1:Math.floor((90-b.s)/sp)};
  }
  _count(r){ return (r.x1-r.x0+1)*(r.y1-r.y0+1); }
  // plus haut zoom dont la zone tient dans maxTiles ; 0 = zone trop vaste pour l'IGN
  chooseZoom(b){
    for(let z=this.zMax; z>=this.zMin; z--) if(this._count(this._tileRange(b,z))<=this.maxTiles) return z;
    return 0;
  }
  // l'IGN est-il utilisable ici ? couverture géographique, taille de la zone, tuiles déjà vues hors couverture
  applies(b){
    if(!b) return false;
    if(!IGN_COVERAGE.some(c=>b.s>=c.s && b.n<=c.n && b.w>=c.w && b.e<=c.e)) return false;
    const z=this.chooseZoom(b); if(!z) return false;
    const r=this._tileRange(b,z);
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++) if(this.outside.has(z+':'+x+':'+y)) return false;
    return true;
  }
  zoneName(b){
    const c=b && IGN_COVERAGE.find(c=>b.s>=c.s && b.n<=c.n && b.w>=c.w && b.e<=c.e);
    return c ? c.name : null;
  }
  _needsLoad(key,z,x,y){
    if(this.outside.has(z+':'+x+':'+y)) return false;
    if(!this.grid.has(key)) return true;
    if(this.grid.get(key)) return false;
    return Date.now()-(this.failedAt.get(key)||0) > this.retryMs;
  }
  missingTiles(b){
    if(!b) return 0;
    const r=this._tileRange(b,this.z); let n=0;
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++){ const k=x*65536+y; if(!this.grid.has(k) || !this.grid.get(k)) n++; }
    return n;
  }
  covers(b){
    if(!b) return true;
    if(this.chooseZoom(b)!==this.z) return false;
    const r=this._tileRange(b,this.z);
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++) if(this._needsLoad(x*65536+y,this.z,x,y)) return false;
    return true;
  }
  async ensure(b, onProgress){
    if(!b) return {loaded:0, failed:0};
    const z=this.chooseZoom(b) || this.zMin;
    if(z!==this.z){ this.z=z; this.grid.clear(); this._lastKey=-1; this._lastTile=null; this.version++; }
    const r=this._tileRange(b,z);
    const todo=[];
    for(let x=r.x0;x<=r.x1;x++) for(let y=r.y0;y<=r.y1;y++) if(this._needsLoad(x*65536+y,z,x,y)) todo.push([x,y]);
    if(!todo.length) return {loaded:0, failed:0};
    let done=0, failed=0;
    const worker=async()=>{
      while(todo.length){
        const [x,y]=todo.shift();
        if(!(await this._load(z,x,y))) failed++;
        done++; if(onProgress) onProgress(done, done+todo.length);
      }
    };
    await Promise.all([worker(),worker(),worker(),worker(),worker(),worker()]);
    this.failedTiles += failed;
    this.version++;
    return {loaded:done-failed, failed};
  }
  _decode(buf){
    if(buf.byteLength < 65536*4) return null;
    const arr=new Float32Array(65536);
    let nodata=0;
    if(LITTLE_ENDIAN){
      const src=new Float32Array(buf,0,65536);
      for(let i=0;i<65536;i++){ const v=src[i]; if(v<-1000 || v>9000 || !Number.isFinite(v)){ arr[i]=NaN; nodata++; } else arr[i]=v; }
    } else {
      const dv=new DataView(buf);
      for(let i=0;i<65536;i++){ const v=dv.getFloat32(i*4,true); if(v<-1000 || v>9000 || !Number.isFinite(v)){ arr[i]=NaN; nodata++; } else arr[i]=v; }
    }
    return {arr, nodata:nodata/65536};
  }
  _load(z,x,y){
    const key=x*65536+y;
    if(this.inflight.has(key)) return this.inflight.get(key);
    const fail=(permanent)=>{
      if(permanent) this.outside.add(z+':'+x+':'+y);
      this.grid.set(key,null); this.failedAt.set(key,Date.now());
      this._lastKey=-1; this._lastTile=null;
      return false;
    };
    const pr=(async()=>{
      try{
        const r=await fetch(IgnDEM.url(z,x,y), {cache:'force-cache'});
        // 404 « No data found » : tuile hors de la couverture RGE ALTI
        if(r.status===404) return fail(true);
        if(!r.ok) return fail(false);
        const dec=this._decode(await r.arrayBuffer());
        if(!dec) return fail(false);
        // tuile essentiellement vide (mer, pays voisin) : inexploitable, la zone repassera au SRTM
        if(dec.nodata > this.nodataMax) return fail(true);
        if(z===this.z){ this.grid.set(key,dec.arr); this._lastKey=-1; this._lastTile=null; }
        return true;
      }catch(e){ return fail(false); }
    })();
    const wrapped=pr.then(v=>{ this.inflight.delete(key); return v; });
    this.inflight.set(key,wrapped);
    return wrapped;
  }
  _px(X,Y){
    const tx=X>>8, ty=Y>>8, key=tx*65536+ty;
    let t;
    if(key===this._lastKey) t=this._lastTile;
    else { t=this.grid.get(key); this._lastKey=key; this._lastTile=t; }
    if(!t) return NaN;
    return t[((Y-(ty<<8))<<8) + (X-(tx<<8))];
  }
  sampleGridPx(px,py){
    const fx=px-0.5, fy=py-0.5, x0=Math.floor(fx), y0=Math.floor(fy), tx=fx-x0, ty=fy-y0;
    const v00=this._px(x0,y0), v10=this._px(x0+1,y0), v01=this._px(x0,y0+1), v11=this._px(x0+1,y0+1);
    const v=(v00*(1-tx)+v10*tx)*(1-ty) + (v01*(1-tx)+v11*tx)*ty;
    if(!Number.isNaN(v)) return v;
    for(const c of [v00,v10,v01,v11]) if(!Number.isNaN(c)) return c;
    return NaN;
  }
  _grid(lat,lng){
    const sp=this._span(this.z)/256;
    return {x:(lng+180)/sp, y:(90-lat)/sp};
  }
  elevation(lat,lng){ const p=this._grid(lat,lng); return this.sampleGridPx(p.x,p.y); }
  lineSampler(a,b){
    const p0=this._grid(a.lat,a.lng), p1=this._grid(b.lat,b.lng);
    const dx=p1.x-p0.x, dy=p1.y-p0.y;
    return t=>this.sampleGridPx(p0.x+dx*t, p0.y+dy*t);
  }
}

/* ---------------------------------------------------------------------
   MNT SYNTHÉTIQUE — ancien moteur procédural, conservé comme repli
   hors-ligne. Clairement étiqueté [Estimation] : NE représente PAS le
   relief réel.
--------------------------------------------------------------------- */
class SyntheticDEM{
  constructor(seed=1337, roughness=0.55, baseAlt=180, amplitude=260){
    this.id='synthetic'; this.name='Relief synthétique (bruit procédural)';
    this.seed=seed; this.roughness=roughness; this.baseAlt=baseAlt; this.amplitude=amplitude;
    this.perm=this._buildPerm(seed); this.version=0; this.resolutionM=50;
  }
  _buildPerm(seed){
    let s=seed>>>0;
    const rnd=()=>{ s^=s<<13; s^=s>>>17; s^=s<<5; s>>>=0; return (s%100000)/100000; };
    const p=[...Array(256).keys()];
    for(let i=255;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
    return p.concat(p);
  }
  _fade(t){ return t*t*t*(t*(t*6-15)+10); }
  _grad(hash,x,y){ const h=hash&3; const u=h<2?x:y, v=h<2?y:x; return ((h&1)?-u:u)+((h&2)?-2*v:2*v); }
  _noise2(x,y){
    const X=Math.floor(x)&255, Y=Math.floor(y)&255;
    x-=Math.floor(x); y-=Math.floor(y);
    const u=this._fade(x), v=this._fade(y), p=this.perm;
    const aa=p[p[X]+Y], ab=p[p[X]+Y+1], ba=p[p[X+1]+Y], bb=p[p[X+1]+Y+1];
    const lerp=(a,b,t)=>a+t*(b-a);
    return lerp(lerp(this._grad(aa,x,y),this._grad(ba,x-1,y),u), lerp(this._grad(ab,x,y-1),this._grad(bb,x-1,y-1),u), v);
  }
  elevation(lat,lng){
    let x=lat*220, y=lng*220, amp=1, freq=1, sum=0, norm=0;
    for(let o=0;o<5;o++){ sum+=amp*this._noise2(x*freq*0.35,y*freq*0.35); norm+=amp; amp*=this.roughness; freq*=2; }
    return Math.max(0, this.baseAlt + (sum/norm)*this.amplitude);
  }
  covers(){ return true; }
  async ensure(){ return {loaded:0, failed:0}; }
  lineSampler(a,b){ return t=>this.elevation(a.lat+(b.lat-a.lat)*t, a.lng+(b.lng-a.lng)*t); }
}

/* ---------------------------------------------------------------------
   OCCUPATION DU SOL — OpenStreetMap (Overpass) rastérisé en grille locale
   classes : 0 = dégagé / inconnu, 1 = arbres (forêt, bois), 2 = bâti
--------------------------------------------------------------------- */
const COVER_NONE=0, COVER_TREES=1, COVER_BUILT=2;

/* ---------------------------------------------------------------------
   OCCUPATION DU SOL — grille commune
   Les deux sources (OpenStreetMap et IGN) produisent la même chose : une
   grille de cellules classées « arbres », « bâti » ou « dégagé », plus une
   image de survol pour la carte. Seule la façon de l'obtenir diffère.
--------------------------------------------------------------------- */
class LandCoverGrid{
  constructor(){
    this.bbox=null; this.W=0; this.H=0; this.cells=null; this.cellM=0;
    this.version=0; this.stats=null; this.overlayUrl=null; this.maxAreaKm2=2500;
  }
  covers(b){ return Geo.bboxContains(this.bbox, b); }
  classAt(lat,lng){
    if(!this.cells) return COVER_NONE;
    const b=this.bbox;
    const ix=Math.floor((lng-b.w)/(b.e-b.w)*this.W), iy=Math.floor((b.n-lat)/(b.n-b.s)*this.H);
    if(ix<0||iy<0||ix>=this.W||iy>=this.H) return COVER_NONE;
    return this.cells[iy*this.W+ix];
  }
  lineSampler(a,b){
    if(!this.cells) return ()=>COVER_NONE;
    const bb=this.bbox, W=this.W, H=this.H, cells=this.cells;
    const x0=(a.lng-bb.w)/(bb.e-bb.w)*W, y0=(bb.n-a.lat)/(bb.n-bb.s)*H;
    const x1=(b.lng-bb.w)/(bb.e-bb.w)*W, y1=(bb.n-b.lat)/(bb.n-bb.s)*H;
    return t=>{
      const ix=Math.floor(x0+(x1-x0)*t), iy=Math.floor(y0+(y1-y0)*t);
      return (ix<0||iy<0||ix>=W||iy>=H) ? COVER_NONE : cells[iy*W+ix];
    };
  }
  // grille de travail : ~2048 cellules sur la plus grande dimension, 10 m au minimum
  _grid(b){
    const midLat=(b.s+b.n)/2;
    const widthM=(b.e-b.w)*111320*Math.cos(Geo.toRad(midLat)), heightM=(b.n-b.s)*111320;
    const cellM=Math.max(10, Math.max(widthM,heightM)/2048);
    return {widthM, heightM, cellM,
            W:Math.max(1,Math.ceil(widthM/cellM)), H:Math.max(1,Math.ceil(heightM/cellM))};
  }
  // image de survol : vert pour les arbres, rouge pour le bâti, transparente ailleurs
  _overlay(W,H,cells){
    const ov=document.createElement('canvas'); ov.width=W; ov.height=H;
    const octx=ov.getContext('2d'); const oimg=octx.createImageData(W,H); const od=oimg.data;
    let nT=0,nB=0;
    for(let i=0,j=0;i<W*H;i++,j+=4){
      if(cells[i]===COVER_TREES){ nT++; od[j]=62; od[j+1]=207; od[j+2]=142; od[j+3]=120; }
      else if(cells[i]===COVER_BUILT){ nB++; od[j]=229; od[j+1]=85; od[j+2]=95; od[j+3]=100; }
    }
    octx.putImageData(oimg,0,0);
    this.overlayUrl=ov.toDataURL('image/png');
    return {nT, nB};
  }
}

class OsmLandCover extends LandCoverGrid{
  constructor(){
    super();
    this.id='osm';
    this.name='OpenStreetMap (Overpass API)';
    // Le relais du serveur (/api/overpass) passe en premier quand la page est servie par server.js :
    // de serveur à serveur il n'y a pas de règle CORS, ce qui évite qu'une panne d'un serveur public
    // devienne un refus CORS illisible côté navigateur. Sur un hébergement statique il répond en
    // erreur en quelques millisecondes et la course enchaîne aussitôt sur les serveurs publics.
    const relay = (typeof location!=='undefined' && /^https?:$/.test(location.protocol)) ? [location.origin+'/api/overpass'] : [];
    // Miroirs publics : utilisés seulement quand la page n'a pas de relais (ouverte
    // depuis un fichier, ou hébergement statique). Dès que le serveur en fournit un,
    // c'est lui seul qui est appelé : il interroge ces mêmes miroirs, garde les
    // réponses en cache et écarte ceux qui sont en panne. Les rappeler depuis le
    // navigateur doublerait la charge sur des serveurs déjà saturés, épuiserait leur
    // quota deux fois plus vite, et produirait les erreurs CORS bruyantes que le
    // navigateur affiche quand un serveur en panne répond sans en-tête CORS.
    // Vérifiés sur leur contenu (polygones réellement renvoyés pour une zone boisée
    // française), pas seulement sur leur code HTTP : overpass.osm.ch, par exemple, ne
    // porte que la Suisse et répond 200 avec une liste vide ailleurs.
    this.publicEndpoints=[
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
    this.relayEndpoint=relay[0]||null;
    this.relayOff=false;
    this.endpoints=relay.length ? relay.slice() : this.publicEndpoints.slice();
  }
  // Les serveurs Overpass publics sont souvent saturés (504, 429, ou pas de réponse du tout).
  // On commence par le dernier serveur qui a répondu ; sans réponse au bout de 8 s, le suivant est lancé
  // en parallèle, et la première réponse valide l'emporte (les autres requêtes sont annulées).
  _ordered(){
    let best=this.best;
    if(!best){ try{ best=localStorage.getItem('meshlab.overpassBest'); }catch(e){} }
    return best && this.endpoints.includes(best) ? [best, ...this.endpoints.filter(e=>e!==best)] : this.endpoints.slice();
  }
  _remember(ep){ this.best=ep; try{ localStorage.setItem('meshlab.overpassBest', ep); }catch(e){} }
  _label(ep){
    if(ep.endsWith('/api/overpass')) return 'relais du serveur';
    try{ return new URL(ep).host; }catch(e){ return ep; }
  }
  _fetchFirst(q, onStatus){
    const eps=this._ordered(), body='data='+encodeURIComponent(q);
    return new Promise((resolve,reject)=>{
      let settled=false, started=0, failed=0;
      const ctrls=[], errors=[];
      const startNext=()=>{
        if(settled || started>=eps.length) return;
        const ep=eps[started++], host=this._label(ep), ac=new AbortController();
        ctrls.push(ac);
        onStatus && onStatus(`Requête OpenStreetMap : ${eps.slice(0,started).map(e=>this._label(e)).join(', ')}…`);
        const abortTimer=setTimeout(()=>ac.abort(), 60000);
        // le relais du serveur interroge lui-meme les miroirs : on lui laisse plus de temps
        // avant de lancer une requete concurrente, pour ne pas charger deux fois les serveurs publics
        const staggerTimer=setTimeout(startNext, ep.endsWith('/api/overpass') ? 20000 : 8000);
        fetch(ep, {method:'POST', body, headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal:ac.signal})
          .then(async r=>{
            if(ep===this.relayEndpoint && r.status===404) this.relayOff=true;   // relais désactivé sur le serveur
            if(!r.ok) throw new Error(`${host} : erreur ${r.status}${r.status===504||r.status===429?' (serveur saturé)':''}`);
            const j=await r.json();
            if(settled) return;
            settled=true; this._remember(ep);
            ctrls.forEach(c=>{ if(c!==ac) c.abort(); });
            resolve(j);
          })
          .catch(e=>{
            if(settled) return;
            errors.push(e.name==='AbortError' ? `${host} : pas de réponse` : e.message);
            failed++; clearTimeout(staggerTimer);
            if(failed<eps.length) return startNext();
            if(this.relayOff && this.endpoints.length===1){   // pas de relais : on se rabat sur les miroirs publics
              this.relayOff=false; this.relayEndpoint=null;
              this.endpoints=this.publicEndpoints.slice();
              settled=true;
              return this._fetchFirst(q, onStatus).then(resolve, reject);
            }
            reject(new Error(`serveurs OpenStreetMap indisponibles (${errors.join(' ; ')})`));
          })
          .finally(()=>clearTimeout(abortTimer));
      };
      startNext();
    });
  }
  async load(b, onStatus){
    const area = Geo.bboxAreaKm2(b);
    if(area > this.maxAreaKm2) throw new Error(`zone de ${Math.round(area)} km² — maximum ${this.maxAreaKm2} km² pour l'API Overpass`);
    const bb=`${b.s.toFixed(5)},${b.w.toFixed(5)},${b.n.toFixed(5)},${b.e.toFixed(5)}`;
    const built='^(residential|commercial|industrial|retail)$';
    const q=`[out:json][timeout:120];(`+
      `way["landuse"="forest"](${bb});relation["landuse"="forest"](${bb});`+
      `way["natural"="wood"](${bb});relation["natural"="wood"](${bb});`+
      `way["landuse"~"${built}"](${bb});relation["landuse"~"${built}"](${bb});`+
      `);out geom qt;`;
    const json=await this._fetchFirst(q, onStatus);
    onStatus && onStatus(`Rastérisation de ${json.elements.length} polygones…`);
    this._rasterize(b, json.elements);
    this.version++;
    return {elements:json.elements.length};
  }
  _rasterize(b, elements){
    const {cellM, W, H} = this._grid(b);
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d',{willReadFrequently:true});
    const X=lng=>(lng-b.w)/(b.e-b.w)*W, Y=lat=>(b.n-lat)/(b.n-b.s)*H;
    const same=(p,q)=>p.lat===q.lat&&p.lon===q.lon;
    const rings=el=>{
      if(el.type==='way') return el.geometry?[el.geometry]:[];
      const ways=(el.members||[]).filter(m=>m.type==='way'&&m.geometry&&m.geometry.length).map(m=>m.geometry.slice());
      const out=[];
      while(ways.length){
        let ring=ways.shift(), guard=0;
        while(!same(ring[0],ring[ring.length-1]) && guard++<5000){
          const end=ring[ring.length-1];
          const idx=ways.findIndex(w=>same(w[0],end)||same(w[w.length-1],end));
          if(idx<0) break;
          const w=ways.splice(idx,1)[0]; if(!same(w[0],end)) w.reverse();
          ring=ring.concat(w.slice(1));
        }
        out.push(ring);
      }
      return out;
    };
    const fillEl=(el,color)=>{
      const rs=rings(el); if(!rs.length) return;
      ctx.beginPath();
      rs.forEach(r=>{ r.forEach((p,i)=>i?ctx.lineTo(X(p.lon),Y(p.lat)):ctx.moveTo(X(p.lon),Y(p.lat))); ctx.closePath(); });
      ctx.fillStyle=color; ctx.fill('evenodd');
    };
    const isTree=t=>t&&(t.landuse==='forest'||t.natural==='wood');
    elements.filter(e=>!isTree(e.tags)).forEach(e=>fillEl(e,'rgb(255,0,0)'));   // bâti d'abord
    elements.filter(e=>isTree(e.tags)).forEach(e=>fillEl(e,'rgb(0,255,0)'));    // les bois recouvrent (parcs boisés en ville)
    const data=ctx.getImageData(0,0,W,H).data;
    const cells=new Uint8Array(W*H);
    for(let i=0,j=0;i<W*H;i++,j+=4)
      cells[i] = data[j+1]>127 ? COVER_TREES : (data[j]>127 ? COVER_BUILT : COVER_NONE);
    const {nT, nB} = this._overlay(W,H,cells);
    this.bbox=b; this.W=W; this.H=H; this.cells=cells; this.cellM=cellM;
    this.stats={treesPct:nT/(W*H)*100, builtPct:nB/(W*H)*100, polygons:elements.length, source:'osm'};
  }
}

/* ---------------------------------------------------------------------
   OCCUPATION DU SOL IGN — BD TOPO végétation et bâti (France et DOM)
   Overpass est une API publique partagée : quotas serrés, instances en
   panne, et des pannes qui se présentent au navigateur comme des refus
   CORS. La Géoplateforme, elle, sert des images WMS sans quota, avec
   l'en-tête CORS qu'il faut, en quelques centaines de millisecondes — et
   ses données sont meilleures que celles d'OSM sur la France.

   On demande deux images transparentes (végétation, bâtiments) qu'on
   redessine directement dans la grille de cellules : pas de polygones à
   assembler, donc pas de limite de nombre d'objets.

   Deux pièges, mesurés et contournés ici :
   — ces couches sont dessinées à partir de données vectorielles et ne
     dessinent plus rien au-delà d'une certaine grossièreté (végétation
     ~7 m/pixel, bâti ~4,8 m/pixel). On demande donc les images plus fines
     que la grille, quitte à les découper en plusieurs morceaux ;
   — la végétation est colorée par type. Les verts sont des bois, les
     tons orangés des vignes et vergers, qui n'arrêtent pas les ondes de
     la même façon : on ne retient que ce qui est franchement vert.
--------------------------------------------------------------------- */
const IGN_WMS = 'https://data.geopf.fr/wms-v/ows';
const IGN_LAYER_VEG   = 'BDTOPO-GEOPO-VEGETATION_WLD_WGS84G';
const IGN_LAYER_BUILT = 'BDTOPO-GEOPO-BATI_WLD_WGS84G';

class IgnLandCover extends LandCoverGrid{
  constructor(){
    super();
    this.id='ign';
    this.name='IGN BD TOPO (végétation et bâti)';
    this.vegMPerPx=6;        // au-delà, la couche végétation cesse d'être dessinée
    this.builtMPerPx=4;      // le bâti, plus fin, exige davantage
    this.maxTilePx=4000;     // le service plafonne à 5010 pixels
    this.maxTiles=8;
    this.downUntil=0;        // après un échec, on laisse la main à OpenStreetMap un moment
  }
  static url(layer, bbox, w, h){
    return IGN_WMS + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
      + '&LAYERS=' + layer + '&STYLES=&CRS=CRS:84&FORMAT=image/png&TRANSPARENT=TRUE'
      + `&BBOX=${bbox}&WIDTH=${w}&HEIGHT=${h}`;
  }
  applies(b){
    if(!b || Date.now() < this.downUntil) return false;
    return IGN_COVERAGE.some(c => b.s>=c.s && b.n<=c.n && b.w>=c.w && b.e<=c.e);
  }
  // découpe la zone en morceaux assez fins pour que la couche accepte de se dessiner
  _tiles(b, widthM, heightM, mPerPx){
    let needW=Math.ceil(widthM/mPerPx), needH=Math.ceil(heightM/mPerPx);
    let nx=Math.max(1,Math.ceil(needW/this.maxTilePx)), ny=Math.max(1,Math.ceil(needH/this.maxTilePx));
    // zone très vaste : on se résout à une image plus grossière plutôt qu'à vingt requêtes
    while(nx*ny > this.maxTiles){
      needW=Math.ceil(needW*0.8); needH=Math.ceil(needH*0.8);
      nx=Math.max(1,Math.ceil(needW/this.maxTilePx)); ny=Math.max(1,Math.ceil(needH/this.maxTilePx));
    }
    const px=Math.ceil(needW/nx), py=Math.ceil(needH/ny), out=[];
    for(let ty=0; ty<ny; ty++) for(let tx=0; tx<nx; tx++){
      const w0=b.w+(b.e-b.w)*tx/nx, w1=b.w+(b.e-b.w)*(tx+1)/nx;
      const n1=b.n-(b.n-b.s)*ty/ny, s1=b.n-(b.n-b.s)*(ty+1)/ny;
      out.push({bbox:`${w0.toFixed(6)},${s1.toFixed(6)},${w1.toFixed(6)},${n1.toFixed(6)}`,
                px, py, fx:tx/nx, fy:ty/ny, fw:1/nx, fh:1/ny});
    }
    return out;
  }
  async _draw(b, W, H, layer, mPerPx, widthM, heightM, onStatus, label){
    const tiles=this._tiles(b, widthM, heightM, mPerPx);
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d',{willReadFrequently:true});
    let done=0;
    onStatus && onStatus(`IGN ${label} : ${tiles.length} image(s)…`);
    await Promise.all(tiles.map(async t=>{
      const r=await fetch(IgnLandCover.url(layer, t.bbox, t.px, t.py), {cache:'force-cache'});
      if(!r.ok) throw new Error(`IGN ${label} : erreur ${r.status}`);
      const blob=await r.blob();
      if(blob.type && blob.type.indexOf('image')<0) throw new Error(`IGN ${label} : réponse inattendue`);
      const bmp=await createImageBitmap(blob);
      ctx.drawImage(bmp, t.fx*W, t.fy*H, t.fw*W, t.fh*H);
      bmp.close && bmp.close();
      done++; onStatus && onStatus(`IGN ${label} : ${done}/${tiles.length}…`);
    }));
    return ctx.getImageData(0,0,W,H).data;
  }
  // Marque une cellule dès qu'un pixel opaque se trouve à moins de r cellules.
  // Somme intégrale : le voisinage se teste en temps constant, quelle que soit r.
  _spread(data, W, H, r, minAlpha){
    const hit=new Uint8Array(W*H);
    for(let i=0,j=3;i<W*H;i++,j+=4) if(data[j]>minAlpha) hit[i]=1;
    if(r<1) return hit;
    const S=new Int32Array((W+1)*(H+1));
    for(let y=0;y<H;y++){
      let row=0;
      for(let x=0;x<W;x++){ row+=hit[y*W+x]; S[(y+1)*(W+1)+x+1]=S[y*(W+1)+x+1]+row; }
    }
    const out=new Uint8Array(W*H);
    for(let y=0;y<H;y++){
      const y0=Math.max(0,y-r), y1=Math.min(H-1,y+r);
      for(let x=0;x<W;x++){
        const x0=Math.max(0,x-r), x1=Math.min(W-1,x+r);
        if(S[(y1+1)*(W+1)+x1+1] - S[y0*(W+1)+x1+1] - S[(y1+1)*(W+1)+x0] + S[y0*(W+1)+x0] > 0) out[y*W+x]=1;
      }
    }
    return out;
  }
  async load(b, onStatus){
    const area=Geo.bboxAreaKm2(b);
    if(area > this.maxAreaKm2) throw new Error(`zone de ${Math.round(area)} km² — maximum ${this.maxAreaKm2} km²`);
    const {widthM, heightM, cellM, W, H} = this._grid(b);
    let veg, built;
    try{
      [veg, built] = await Promise.all([
        this._draw(b, W, H, IGN_LAYER_VEG,   this.vegMPerPx,   widthM, heightM, onStatus, 'végétation'),
        this._draw(b, W, H, IGN_LAYER_BUILT, this.builtMPerPx, widthM, heightM, onStatus, 'bâti')
      ]);
    }catch(e){
      this.downUntil = Date.now() + 5*60000;   // on repasse à OpenStreetMap pendant 5 min
      throw e;
    }
    const cells=new Uint8Array(W*H);
    // La BD TOPO donne des bâtiments, objets isolés, là où le modèle de clutter raisonne
    // en « zone bâtie » avec une hauteur représentative : sans rien faire, un trajet qui
    // traverse un village passerait surtout entre les maisons. On élargit donc légèrement
    // le bâti (environ 25 m) pour retrouver l'enveloppe du village, ce qui redonne à peu
    // près ce que décrivent les zones landuse=residential d'OpenStreetMap.
    const builtMask=this._spread(built, W, H, Math.max(1, Math.round(25/cellM)), 10);
    // Le bâti est posé en premier, la végétation le recouvre : un bois en ville reste un
    // bois (15 m d'obstacle plutôt que 10), comme dans la version OpenStreetMap.
    // La végétation est colorée par type : on ne retient que les verts francs, pour
    // écarter vignes et vergers, qui ne forment pas un obstacle de 15 m.
    for(let i=0,j=0;i<W*H;i++,j+=4){
      if(builtMask[i]) cells[i]=COVER_BUILT;
      if(veg[j+3] > 32 && veg[j+1] > veg[j]+10 && veg[j+1] > veg[j+2]+10) cells[i]=COVER_TREES;
    }
    const {nT, nB} = this._overlay(W,H,cells);
    this.bbox=b; this.W=W; this.H=H; this.cells=cells; this.cellM=cellM;
    this.stats={treesPct:nT/(W*H)*100, builtPct:nB/(W*H)*100, polygons:null, source:'ign'};
    this.version++;
    return {cells:W*H};
  }
}



/* ---------------------------------------------------------------------
   COMMUNES — chefs-lieux de l'IGN (ADMIN EXPRESS), pour nommer les nœuds
   Une seule requête WFS couvre toute la zone du réseau : quelques dizaines
   de points, une vingtaine de kilo-octets. Le nom du nœud se lit alors sur
   la carte comme sur le terrain — « R-ANDE », c'est le répéteur des Andelys.
--------------------------------------------------------------------- */
const IGN_WFS = 'https://data.geopf.fr/wfs/ows';
const IGN_LAYER_COMMUNE = 'ADMINEXPRESS-COG-CARTO-PE.LATEST:chef_lieu_de_commune';

// « LES ANDELYS » → « ANDE ». On écarte l'article, les accents et la ponctuation,
// et on abrège SAINT/SAINTE : sans cela, toutes les communes en Saint- se
// ramèneraient à « SAIN » et le nom ne dirait plus rien. Vérifié sur les 39
// communes autour des Andelys : 4 collisions deviennent 3, et elles portent sur
// des noms réellement proches (PORT-MORT / PORTE-DE-SEINE).
function communeAbbr(nom){
  let s = String(nom||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  s = s.replace(/^(LES |LE |LA |L')/, '');
  s = s.replace(/^SAINTE[- ]/, 'STE').replace(/^SAINT[- ]/, 'ST');
  s = s.replace(/[^A-Z]/g, '');
  return s.slice(0, 4);
}

class CommuneIndex{
  constructor(){
    this.bbox=null; this.pts=[]; this.version=0;
    this.downUntil=0; this.truncated=false;
  }
  applies(b){
    if(!b || Date.now() < this.downUntil) return false;
    return IGN_COVERAGE.some(c => b.s>=c.s && b.n<=c.n && b.w>=c.w && b.e<=c.e);
  }
  covers(b){ return Geo.bboxContains(this.bbox, b); }
  static url(b){
    return IGN_WFS + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
      + '&TYPENAMES=' + encodeURIComponent(IGN_LAYER_COMMUNE)
      + '&OUTPUTFORMAT=application/json&COUNT=2000'
      + `&BBOX=${b.w.toFixed(5)},${b.s.toFixed(5)},${b.e.toFixed(5)},${b.n.toFixed(5)},urn:ogc:def:crs:OGC:1.3:CRS84`;
  }
  async load(b){
    let j;
    try{
      const r = await fetch(CommuneIndex.url(b), {cache:'force-cache'});
      if(!r.ok) throw new Error('HTTP '+r.status);
      j = await r.json();
    }catch(e){
      this.downUntil = Date.now() + 5*60000;    // le nommage automatique attendra
      throw e;
    }
    const feats = (j && j.features) || [];
    this.pts = feats.map(f=>{
      const c = f.geometry && f.geometry.coordinates;
      const p = f.properties || {};
      if(!c) return null;
      const nom = p.nom_officiel_en_majuscules || p.nom_officiel || '';
      return {lat:c[1], lng:c[0], nom:p.nom_officiel||nom, abbr:communeAbbr(nom)};
    }).filter(Boolean);
    this.truncated = !!(j && j.numberMatched && j.numberMatched > this.pts.length);
    this.bbox = b; this.version++;
    return {count:this.pts.length};
  }
  nearest(lat, lng){
    let best=null, bestD=Infinity;
    for(const p of this.pts){
      // comparaison au carré en degrés corrigés : inutile de calculer une vraie
      // distance pour des dizaines de points, seul le classement compte
      const dy=p.lat-lat, dx=(p.lng-lng)*Math.cos(Geo.toRad(lat));
      const d=dy*dy+dx*dx;
      if(d<bestD){ bestD=d; best=p; }
    }
    return best ? {nom:best.nom, abbr:best.abbr, distM:Geo.distanceM({lat,lng}, {lat:best.lat,lng:best.lng})} : null;
  }
}


/* ---------------------------------------------------------------------
   IGN RGE ALTI — profil haute précision à la demande (France uniquement)
--------------------------------------------------------------------- */
const IgnAltimetry = {
  async profile(a, b, samples=200){
    const url = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevationLine.json'
      + `?lon=${a.lng.toFixed(6)}|${b.lng.toFixed(6)}&lat=${a.lat.toFixed(6)}|${b.lat.toFixed(6)}`
      + `&resource=ign_rge_alti_wld&delimiter=|&indent=false&measures=false&zonly=false&profile_mode=simple&sampling=${samples}`;
    const r = await fetch(url);
    if(!r.ok) throw new Error('IGN HTTP '+r.status);
    const j = await r.json();
    const z = (j.elevations||[]).map(e=>e.z);
    if(z.length<2) throw new Error('réponse IGN vide');
    if(z.some(v=>v<=-9999)) throw new Error('hors couverture IGN (France uniquement)');
    return z; // altitudes régulièrement espacées de A vers B
  }
};

/* ---------------------------------------------------------------------
   PROPAGATION
--------------------------------------------------------------------- */
const Propagation = {
  _buf: { d:new Float64Array(0), g:new Float64Array(0), gc:new Float64Array(0), cls:new Uint8Array(0) },
  _ensureBuf(n){
    if(this._buf.d.length<n){ this._buf={ d:new Float64Array(n), g:new Float64Array(n), gc:new Float64Array(n), cls:new Uint8Array(n) }; }
    return this._buf;
  },
  fspl(distanceKm, freqMHz){
    return 20*Math.log10(Math.max(distanceKm,0.001)) + 20*Math.log10(freqMHz) + 32.44;
  },
  // Fonction de perte de diffraction en lame de couteau — ITU-R P.526 (éq. 31), valable pour v > −0,78
  J(v){ return v<=-0.78 ? 0 : 6.9 + 20*Math.log10(Math.sqrt((v-0.1)*(v-0.1)+1) + v - 0.1); },
  // ITU-R P.2108 §3.1 — perte de clutter pour un terminal sous la hauteur représentative R du clutter
  terminalClutterLoss(hAnt, R, freqMHz){
    if(!R || hAnt>=R) return 0;
    const fG=freqMHz/1000, ws=27, hdif=R-Math.max(hAnt,0);
    const thetaDeg=Math.atan(hdif/ws)*180/Math.PI;
    const nu=0.342*Math.sqrt(fG)*Math.sqrt(hdif*thetaDeg);
    return Math.max(0, this.J(nu)-6.03);
  },
  // ITU-R P.833 — atténuation excédentaire dans la végétation (saturante)
  vegetationLoss(depthM, freqMHz, gammaDbPerM){
    if(depthM<=0) return 0;
    const Am=0.18*Math.pow(freqMHz,0.752);
    return Am*(1-Math.exp(-depthM*gammaDbPerM/Am));
  },
  _mainEdge(h,d,i0,i1,h0,h1,lambda){
    let best=-Infinity, bi=-1;
    const D=d[i1]-d[i0];
    for(let i=i0+1;i<i1;i++){
      const d1=d[i]-d[i0], d2=d[i1]-d[i];
      if(d1<=0||d2<=0) continue;
      const v=(h[i]-(h0+(h1-h0)*d1/D))*Math.sqrt(2*D/(lambda*d1*d2));
      if(v>best){ best=v; bi=i; }
    }
    return {v:best, i:bi};
  },
  // ITU-R P.526 §4.2 — terme supplémentaire T(m,n) d'un obstacle arrondi de rayon R (au-delà de la lame de couteau).
  // Plafonné à 40 dB : pour des rayons immenses le polynôme sort de son domaine de validité.
  roundedCorrection(R, d1, d2, h, lambda){
    if(!(R>0) || !(h>0)) return 0;
    const k=Math.PI*R/lambda;
    const m=Math.min(4, R*((d1+d2)/(d1*d2))/Math.cbrt(k));
    const n=h*Math.pow(k,2/3)/R;
    const mn=m*n;
    const T = mn<=4
      ? 7.2*Math.sqrt(m) - (2-12.5*n)*m + 3.6*Math.pow(m,1.5) - 0.8*m*m
      : -6 - 20*Math.log10(mn) + 7.2*Math.sqrt(m) - (2-17*n)*m + 3.6*Math.pow(m,1.5) - 0.8*m*m;
    return Math.max(0, Math.min(T, 40));
  },
  // Obstacle équivalent de Bullington (intersection des deux rayons d'horizon) + correction d'obstacle arrondi.
  // Le rayon de courbure est estimé par la géométrie : distance entre les deux points d'horizon / angle de diffraction.
  // Un plateau large (points d'horizon éloignés) donne un grand rayon et une forte perte, là où Deygout ne voit que des arêtes fines.
  bullingtonRounded(h,d,n,hA,hB,lambda){
    const D=d[n];
    let sA=-Infinity, iA=-1, sB=-Infinity, iB=-1;
    for(let i=1;i<n;i++){
      const a=(h[i]-hA)/d[i]; if(a>sA){ sA=a; iA=i; }
      const b=(h[i]-hB)/(D-d[i]); if(b>sB){ sB=b; iB=i; }
    }
    const sLos=(hB-hA)/D;
    if(iA<0 || sA<=sLos) return {loss:0, J:0, T:0, R:0, obstructed:false};   // visée dégagée par le relief
    const x=(hB-hA+sB*D)/(sA+sB);
    const d1=Math.max(1,Math.min(D-1,x)), d2=D-d1;
    const hv=(hA+sA*d1)-(hA+sLos*d1);
    const J=this.J(hv*Math.sqrt(2*D/(lambda*d1*d2)));
    const theta=Math.atan(sA)+Math.atan(sB);
    // largeur de l'obstacle : distance entre les points d'horizon (ITU-R P.526), élargie de proche en proche aux
    // échantillons CONTIGUS qui restent tout près des rayons d'horizon (sommet large). On s'arrête au premier
    // échantillon qui décroche, pour ne pas englober le sol au pied des antennes.
    const depth=Math.max(2, Math.min(0.3*Math.sqrt(lambda*d1*d2/D), 0.5*hv));
    const envAt=i=>Math.min(hA+sA*d[i], hB+sB*(D-d[i]));
    let first=Math.min(iA,iB), last=Math.max(iA,iB);
    while(first>1 && h[first-1]>=envAt(first-1)-depth) first--;
    while(last<n-1 && h[last+1]>=envAt(last+1)-depth) last++;
    const Ds=d[last]-d[first];
    const R = theta>0 ? Ds/theta : 0;
    const T=this.roundedCorrection(R,d1,d2,hv,lambda);
    return {loss:J+T, J, T, R, Ds, obstructed:true};
  },
  // Deygout limité à 3 arêtes. Les arêtes secondaires ne sont prises en compte que si l'arête
  // principale obstrue réellement la visée (v > 0) et sont pondérées par T = 1 − exp(−J(vp)/6) :
  // sans cela, un sol lisse en incidence rasante produit ~10 dB de perte fictive.
  deygout(h,d,n,h0,h1,lambda){
    const m=this._mainEdge(h,d,0,n,h0,h1,lambda);
    if(m.i<0 || m.v<=-0.78) return {loss:0, vMain:m.v, iMain:m.i};
    const Jp=this.J(m.v);
    let loss=Jp;
    if(m.v>0){
      const hm=h[m.i], T=1-Math.exp(-Jp/6);
      let sub=0;
      if(m.i>1){ const s=this._mainEdge(h,d,0,m.i,h0,hm,lambda); if(s.i>=0) sub+=this.J(s.v); }
      if(n-m.i>1){ const s=this._mainEdge(h,d,m.i,n,hm,h1,lambda); if(s.i>=0) sub+=this.J(s.v); }
      loss+=T*sub;
    }
    return {loss, vMain:m.v, iMain:m.i};
  },
  /**
   * Perte de trajet entre deux nœuds (symétrique, hors gains et puissances).
   * env = { dem, cover, freqMHz, kFactor, clutter:{enabled, treeH, builtH, gammaTree, exclusionM}, stepM, overrideProfile }
   */
  pathLoss(a, b, env, wantProfile=false){
    const D=Geo.distanceM(a,b);
    const f=env.freqMHz, lambda=299.792458/f;
    const out={ distM:D, fsplDb:this.fspl(D/1000,f), terrainDb:0, groundDb:0, clutterDb:0, termADb:0, termBDb:0,
      blocked:false, fresnelRatio:99, groundA:0, groundB:0, coverA:COVER_NONE, coverB:COVER_NONE,
      vegDepthM:0, demMissing:false, totalDb:0 };
    const n = env.overrideProfile ? env.overrideProfile.length-1 : Math.max(16, Math.min(160, Math.ceil(D/(env.stepM||40))));
    const buf=this._ensureBuf(n+1), d=buf.d, g=buf.g, gc=buf.gc, cls=buf.cls;
    const elevAt = env.overrideProfile ? (t=>env.overrideProfile[Math.round(t*n)]) : (env.dem ? env.dem.lineSampler(a,b) : null);
    const coverAt = (env.cover && env.clutter && env.clutter.enabled) ? env.cover.lineSampler(a,b) : null;
    const kR = (env.kFactor||4/3)*Geo.R;
    const cl = env.clutter||{};
    const excl = cl.exclusionM ?? 100;
    let lastValid = 0;
    for(let i=0;i<=n;i++){
      const t=i/n, di=D*t;
      d[i]=di;
      let e = elevAt ? elevAt(t) : 0;
      if(Number.isNaN(e)){ out.demMissing=true; e=lastValid; } else lastValid=e;
      g[i] = e + di*(D-di)/(2*kR);            // relief + renflement terrestre
      const c = coverAt ? coverAt(t) : COVER_NONE;
      cls[i]=c;
      const inMid = di>excl && (D-di)>excl;
      gc[i] = g[i] + (inMid ? (c===COVER_TREES ? (cl.treeH||0) : c===COVER_BUILT ? (cl.builtH||0) : 0) : 0);
    }
    out.groundA=g[0]; out.groundB=g[n]; out.coverA=cls[0]; out.coverB=cls[n];
    const hA=g[0]+(a.heightM??2), hB=g[n]+(b.heightM??2);

    // relief seul : on retient la plus forte des deux estimations —
    // Deygout (plusieurs crêtes distinctes) ou Bullington + obstacle arrondi (plateau, colline large)
    const terr=this.deygout(g,d,n,hA,hB,lambda);
    const bul=this.bullingtonRounded(g,d,n,hA,hB,lambda);
    out.deygoutDb=terr.loss; out.bullingtonDb=bul.J; out.roundedDb=bul.T; out.obstacleRadiusM=bul.R; out.horizonSpanM=bul.Ds||0;
    out.terrainDb=Math.max(terr.loss, bul.loss);

    // réflexion sol (modèle terre plane à 2 rayons) avec hauteurs effectives au-dessus du relief moyen du trajet :
    // au-delà de la distance de rupture 4π·h1·h2/λ, la perte croît en 40·log(d) au lieu de 20·log(d).
    // On retient max(diffraction relief, excès terre plane) pour ne pas compter deux fois l'effet du sol.
    let meanG=0;
    for(let i=1;i<n;i++) meanG+=g[i];
    meanG = n>1 ? meanG/(n-1) : (g[0]+g[n])/2;
    const hEffA=Math.max(a.heightM??2, hA-meanG, 1), hEffB=Math.max(b.heightM??2, hB-meanG, 1);
    out.groundDb=Math.max(0, 20*Math.log10(D*lambda/(4*Math.PI*hEffA*hEffB)));
    out.hEffA=hEffA; out.hEffB=hEffB;

    // dégagement de Fresnel, obstruction de la ligne de visée, profondeur de végétation traversée
    let minRatio=Infinity, vegDepth=0;
    const step=D/n;
    for(let i=1;i<n;i++){
      const los=hA+(hB-hA)*d[i]/D;
      const r1=Math.sqrt(lambda*d[i]*(D-d[i])/D);
      if(los<g[i]) out.blocked=true;
      if(r1>0) minRatio=Math.min(minRatio,(los-gc[i])/r1);
      if(cls[i]===COVER_TREES && gc[i]>g[i] && los<gc[i]) vegDepth+=step;
    }
    out.fresnelRatio = minRatio===Infinity ? 99 : minRatio;
    out.vegDepthM=vegDepth;

    // clutter à mi-parcours : surcoût de l'arête dominante quand on ajoute la hauteur du clutter,
    // borné par l'atténuation de traversée de la végétation si le rayon direct la traverse
    if(coverAt){
      const mc=this._mainEdge(gc,d,0,n,hA,hB,lambda);
      const extra=Math.max(0, this.J(mc.v)-this.J(terr.vMain));
      out.clutterDb = vegDepth>0 ? Math.min(extra, this.vegetationLoss(vegDepth,f,cl.gammaTree??0.25)) : extra;
      const R=c=>c===COVER_TREES?cl.treeH:c===COVER_BUILT?cl.builtH:0;
      out.termADb=this.terminalClutterLoss(a.heightM??2, R(cls[0]), f);
      out.termBDb=this.terminalClutterLoss(b.heightM??2, R(cls[n]), f);
    }
    out.obstacleDb = Math.max(out.terrainDb, out.groundDb);
    out.totalDb = out.fsplDb + out.obstacleDb + out.clutterDb + out.termADb + out.termBDb;
    if(wantProfile){
      const prof=[];
      for(let i=0;i<=n;i++) prof.push({d:d[i], g:g[i], gc:gc[i], cls:cls[i]});
      out.profile=prof; out.hA=hA; out.hB=hB; out.lambda=lambda;
    }
    return out;
  }
};
