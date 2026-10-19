/* global THREE */

// ====== Escena ======
let renderer, scene, camera, controls, raycaster, mouse;
const rootGroup = new THREE.Group();
rootGroup.rotation.x = -Math.PI / 2;     // visual: Z (gbXML) -> Y (Three)
const edgesGroup = new THREE.Group();
edgesGroup.rotation.x = -Math.PI / 2;
// Multiselección
const selectedIds = window.selectedIds || new Set();
// Multiselección por rango en el dropdown
let lastAnchorId = null;     // último ítem usado como “ancla” (sincroniza con clic normal)
let spaceOrder = [];         // orden estable de espacios (por nombre) para rangos
const hiddenIds = new Set();

// Referencias del dropdown
const ddRoot    = document.getElementById('spaceMultiDd');
const ddToggle  = document.getElementById('spaceDdToggle');
const ddPanel   = document.getElementById('spaceDdPanel');
const ddFilter  = document.getElementById('spaceDdFilter');
const ddList    = document.getElementById('spaceDdList');
const ddSelAll  = document.getElementById('spaceDdSelAll');
const ddSelNone = document.getElementById('spaceDdSelNone');
const selectionSummaryEl = document.getElementById('selectionSummary');
const selectionCountEl   = document.getElementById('selectionCount');
const selectedListEl     = document.getElementById('selectedList');


// Grupo para ventanas
const windowsGroup = new THREE.Group();
windowsGroup.rotation.x = -Math.PI / 2;

const viewerEl     = document.getElementById('viewer');

const popoverEl   = document.getElementById('spacePopover');
const popTitleEl  = document.getElementById('spacePopoverTitle');
const popSummaryEl= document.getElementById('spacePopoverSummary');
const popTempEl   = document.getElementById('spacePopoverTemp');
const popRhEl     = document.getElementById('spacePopoverRh');
const popRangeEl  = document.getElementById('spacePopoverRange');
const popLiveBadgeEl = document.getElementById('spacePopoverLiveBadge');
const popLiveDotEl   = document.getElementById('spacePopoverLiveDot');

const inSpDay    = document.getElementById('spDay');
const inSpNight  = document.getElementById('spNight');
const inSpTol    = document.getElementById('spTol');
const inSpHrWarn = document.getElementById('spHrWarn');
const inSpHrAlarm= document.getElementById('spHrAlarm');
const btnSaveSpaceCfg = document.getElementById('btnSaveSpaceCfg');

const btnClosePopover = document.getElementById('btnClosePopover');

// Popover range selector (charts)
popRangeEl?.querySelectorAll('button[data-range]')?.forEach(btn => {
  btn.addEventListener('click', () => {
    popoverChartRange = btn.dataset.range || '24h';
    popRangeEl.querySelectorAll('button[data-range]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updatePopoverContentFromTelemetry();
  });
});

let popoverChartRange = '24h';
let popoverWorldPoint = null; // THREE.Vector3 en coords del mundo
let popoverSpaceId = null;

btnClosePopover?.addEventListener('click', () => hidePopover());

btnSaveSpaceCfg?.addEventListener('click', () => {
  if (!popoverSpaceId) return;
  const cfg = {
    spDay: parseFloat(inSpDay?.value),
    spNight: parseFloat(inSpNight?.value),
    tol: parseFloat(inSpTol?.value),
    hrWarn: parseFloat(inSpHrWarn?.value),
    hrAlarm: parseFloat(inSpHrAlarm?.value),
  };
  // sanitize NaNs
  Object.keys(cfg).forEach(k => { if (!Number.isFinite(cfg[k])) delete cfg[k]; });
  saveSpaceCfg(popoverSpaceId, cfg);
  showToast?.('Configuración guardada ✅', 'success');
  // Refresh visuals
  applyAlarmColorsIfNoSelection();
  updatePopoverContentFromTelemetry();
});


function hidePopover(){
  popoverWorldPoint = null;
  popoverSpaceId = null;
  if (popoverEl) popoverEl.classList.add('hidden');
}

function showPopover(spaceId, worldPoint){
  if (!popoverEl) return;
  popoverSpaceId = spaceId;
  popoverWorldPoint = worldPoint ? worldPoint.clone() : null;
  popoverEl.classList.remove('hidden');
  updatePopoverContentFromTelemetry();
  updatePopoverPosition();
}


function updatePopoverContentFromTelemetry(){
  if (!popoverEl) return;
  if (selectedIds.size !== 1) { hidePopover(); return; }
  const only = [...selectedIds][0];
  const sp = spaces.get(only);
  if (popTitleEl) popTitleEl.textContent = sp?.name || only;

  // Fill config inputs
  const cfg = getSpaceCfg(only);
  if (inSpDay) inSpDay.value = cfg.spDay;
  if (inSpNight) inSpNight.value = cfg.spNight;
  if (inSpTol) inSpTol.value = cfg.tol;
  if (inSpHrWarn) inSpHrWarn.value = cfg.hrWarn;
  if (inSpHrAlarm) inSpHrAlarm.value = cfg.hrAlarm;

  // Latest status (for alarms)
  const st = evalSpaceStatus(only);

  // Chart window uses the global range selector (side panel) for now
  const sensorId = telemetryState?.spaceToSensor?.[only];
  const sensor = sensorId ? telemetryState?.sensors?.[sensorId] : null;
  const isLive = !!(sensor && sensor.source === 'live');

  // LIVE: hide range selector
  if (popRangeEl) popRangeEl.style.display = isLive ? 'none' : '';

  // LIVE badge + connection dot
  if (popLiveBadgeEl) popLiveBadgeEl.classList.toggle('hidden', !isLive);
  if (isLive && popLiveDotEl) {
    const key = getLiveMarkerKeyForSensor(sensor);
    popLiveDotEl.classList.remove('ok','stale','err');
    popLiveDotEl.classList.add(key === 'live_ok' ? 'ok' : (key === 'live_stale' ? 'stale' : 'err'));
  }

  const data = sensor ? getRangeFilteredForPopover(sensor.data) : [];

  if (!sensor || !data.length) {
    if (popSummaryEl) popSummaryEl.textContent = sensor
      ? `Estado: ${st.status.toUpperCase()} · ${st.reason} · (sin datos en la ventana)`
      : `Sin sensor asignado. Estado: ${st.status.toUpperCase()} · ${st.reason}`;
    if (popTempEl) popTempEl.innerHTML = '';
    if (popRhEl) popRhEl.innerHTML = '';
    return;
  }

  const lastWin = data[data.length - 1];
  const temps = data.map(p => p.temp);
  const rhs   = data.map(p => p.rh);
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const rmin = Math.min(...rhs),   rmax = Math.max(...rhs);

  const activeSp = st.activeSetpoint ?? getActiveSetpoint(only, lastWin.t);
  const liveInfo = (isLive && sensor && sensor.data && sensor.data.length)
    ? (() => {
        const last = sensor.data[sensor.data.length - 1];
        const ageS = Math.max(0, Math.round((Date.now() - last.t.getTime()) / 1000));
        const pollS = Math.round(SENSOR_POLL_MS / 1000);
        return ` · LIVE · cada ${pollS}s · hace ${ageS}s`;
      })()
    : '';
  if (popSummaryEl) {
    const livePrefix = isLive ? 'LIVE · ' : '';
    const badge = st.status === 'ok' ? 'OK' : (st.status === 'warn' ? 'AVISO' : (st.status === 'alarm' ? 'ALARMA' : 'SIN DATOS'));
    popSummaryEl.textContent =
      `${livePrefix}Estado: ${badge} · SP activo: ${activeSp.toFixed(1)}°C${liveInfo} · ` +
      `Último: ${lastWin.t.toLocaleString()} · ` +
      `${lastWin.temp.toFixed(1)}°C (min ${tmin.toFixed(1)} / max ${tmax.toFixed(1)}) · ` +
      `${lastWin.rh.toFixed(0)}% HR (min ${rmin.toFixed(0)} / max ${rmax.toFixed(0)})`;
  }

  // Render mini charts
  drawSpark(popTempEl, data, 'temp');
  drawSpark(popRhEl, data, 'rh');
}


// Variante de drawSpark con tamaño configurable (para el popover)
function drawSparkSized(svgEl, series, key, W, H) {
  if (!svgEl) return;
  svgEl.innerHTML = '';
  if (!series || series.length < 2) return;

  const pad = 8;
  const xs = series.map(p => p.t.getTime());
  const ys = series.map(p => p[key]);

  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yr = (ymax - ymin) || 1;

  const toX = (t) => pad + ( (t - xmin) / (xmax - xmin || 1) ) * (W - 2*pad);
  const toY = (v) => (H - pad) - ( (v - ymin) / yr ) * (H - 2*pad);

  const mk = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);

  // polyline
  const pl = mk('polyline');
  const pts = series.map(p => `${toX(p.t.getTime()).toFixed(2)},${toY(p[key]).toFixed(2)}`).join(' ');
  pl.setAttribute('points', pts);
  pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', '#d3a93e');
  pl.setAttribute('stroke-width', '2');
  pl.setAttribute('stroke-linejoin', 'round');
  pl.setAttribute('stroke-linecap', 'round');
  svgEl.appendChild(pl);

  // min/max labels
  const t1 = mk('text');
  t1.setAttribute('x', pad); t1.setAttribute('y', pad + 10);
  t1.setAttribute('fill', '#a9b0c0'); t1.setAttribute('font-size', '10');
  t1.textContent = `${ymax.toFixed(1)}`;
  svgEl.appendChild(t1);

  const t2 = mk('text');
  t2.setAttribute('x', pad); t2.setAttribute('y', H - pad);
  t2.setAttribute('fill', '#a9b0c0'); t2.setAttribute('font-size', '10');
  t2.textContent = `${ymin.toFixed(1)}`;
  svgEl.appendChild(t2);
}

function updatePopoverPosition(){
  if (!popoverEl || popoverEl.classList.contains('hidden') || !popoverWorldPoint) return;
  const rect = viewerEl.getBoundingClientRect();
  const v = popoverWorldPoint.clone().project(camera);
  // Si está detrás de la cámara, ocultar
  if (v.z > 1) { hidePopover(); return; }
  const x = (v.x * 0.5 + 0.5) * rect.width + rect.left;
  const y = (-v.y * 0.5 + 0.5) * rect.height + rect.top;

  // posición: un poco a la derecha/abajo del punto
  const pad = 12;
  const popW = popoverEl.offsetWidth || 320;
  const popH = popoverEl.offsetHeight || 200;

  let left = x + pad;
  let top  = y + pad;

  // keep inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  if (left + popW + 8 > vw) left = Math.max(8, x - popW - pad);
  if (top + popH + 8 > vh) top = Math.max(8, y - popH - pad);

  popoverEl.style.left = left + 'px';
  popoverEl.style.top  = top + 'px';
}

const btnImportGbxml = document.getElementById('btnImportGbxml');
const fileEl         = document.getElementById('file'); 
const btnReset     = document.getElementById('btnReset');
const chkEdgesEl   = document.getElementById('chkEdges');
const unitSelectEl = document.getElementById('unitSelect');
const selSpaceEl   = document.getElementById('spaceSelect');
const spaceInfoEl  = document.getElementById('spaceInfo');

// Area/volume labels
const elFloor  = document.getElementById('kvFloor');
const elTotal  = document.getElementById('kvTotal');
const elVol    = document.getElementById('kvVol');
const elWin    = document.getElementById('kvWin'); 


// Loads inputs/outputs
const inDT      = document.getElementById('inDT');
const inPeople  = document.getElementById('inPeople');
const inLtg     = document.getElementById('inLtg');
const inEquip   = document.getElementById('inEquip');

const elQTrans = document.getElementById('kvQTrans');
const elQInt   = document.getElementById('kvQInt');
const elQTot   = document.getElementById('kvQTot');

// Estado del proyecto
const projectState = {
  assemblies: { materials:{}, opaque:{}, windows:{} },
  assignments: {} // { [spaceId]: { wall?, roof?, floor?, window? } }
};


// ====== Telemetría (CSV SwitchBot) ======
const telemetryState = {
  sensors: {},          // { [sensorId]: { id, name, data:[{t:Date, temp:number, rh:number}] } }
  spaceToSensor: {},    // { [spaceId]: sensorId }
};

// ==== Digital Twin comfort config (per space) ====
const DT_DEFAULTS = {
  spDay: 21.5,
  spNight: 13.5,
  tol: 1.0,
  hrWarn: 65,
  hrAlarm: 75
};
// Day windows in minutes since midnight
const DT_DAY_WINDOWS = [
  { start: 7*60, end: 9*60 },       // 07:00–09:00
  { start: 19*60+30, end: 23*60+30 } // 19:30–23:30
];

let dtSpaceConfig = {};
try { dtSpaceConfig = JSON.parse(localStorage.getItem('dtSpaceConfig')||'{}'); } catch(e){ dtSpaceConfig = {}; }

function getSpaceCfg(spaceId){
  const c = dtSpaceConfig[spaceId] || {};
  return {
    spDay:   (c.spDay   ?? DT_DEFAULTS.spDay),
    spNight: (c.spNight ?? DT_DEFAULTS.spNight),
    tol:     (c.tol     ?? DT_DEFAULTS.tol),
    hrWarn:  (c.hrWarn  ?? DT_DEFAULTS.hrWarn),
    hrAlarm: (c.hrAlarm ?? DT_DEFAULTS.hrAlarm),
  };
}
function saveSpaceCfg(spaceId, cfg){
  dtSpaceConfig[spaceId] = { ...getSpaceCfg(spaceId), ...cfg };
  localStorage.setItem('dtSpaceConfig', JSON.stringify(dtSpaceConfig));
}

function minutesSinceMidnight(d){
  return d.getHours()*60 + d.getMinutes();
}
function isDayTime(d){
  const m = minutesSinceMidnight(d);
  return DT_DAY_WINDOWS.some(w => m >= w.start && m < w.end);
}
function getActiveSetpoint(spaceId, atDate){
  const cfg = getSpaceCfg(spaceId);
  return isDayTime(atDate) ? cfg.spDay : cfg.spNight;
}

function getLatestReadingForSpace(spaceId){
  const sensorId = telemetryState.spaceToSensor[spaceId];
  if (!sensorId) return null;
  const s = telemetryState.sensors[sensorId];
  if (!s || !s.data || !s.data.length) return null;
  const last = s.data[s.data.length-1];
  return { t: last.t, temp: last.temp, rh: last.rh, sensorName: s.name || sensorId };
}

const DT_STATUS = { NONE:'none', OK:'ok', WARN:'warn', ALARM:'alarm' };
function worstStatus(a,b){
  const rank = { none:0, ok:1, warn:2, alarm:3 };
  return (rank[a] >= rank[b]) ? a : b;
}
function evalSpaceStatus(spaceId){
  const r = getLatestReadingForSpace(spaceId);
  if (!r) return { status: DT_STATUS.NONE, reason:'Sin datos', activeSetpoint:null, reading:null };

  const cfg = getSpaceCfg(spaceId);
  const isActive = isDayTime(r.t);
  const sp = getActiveSetpoint(spaceId, r.t);

  let st = DT_STATUS.OK;
  let reasons = [];

  // Temperature evaluation:
  // - Active (día): alarm if outside ±tol (both above/below)
  // - Inactive (noche/setback): only alarm if TOO COLD (below setpoint); being above setback is not an alarm
  if (isActive){
    const ad = Math.abs(r.temp - sp);
    if (ad > cfg.tol*2){
      st = DT_STATUS.ALARM;
      reasons.push(`Temp fuera ±${(cfg.tol*2).toFixed(1)}°C`);
    } else if (ad > cfg.tol){
      st = DT_STATUS.WARN;
      reasons.push(`Temp fuera ±${cfg.tol.toFixed(1)}°C`);
    }
  } else {
    const below = sp - r.temp; // >0 means below setback setpoint
    if (below > cfg.tol*2){
      st = DT_STATUS.ALARM;
      reasons.push(`Temp baja >${(cfg.tol*2).toFixed(1)}°C bajo setback`);
    } else if (below > cfg.tol){
      st = DT_STATUS.WARN;
      reasons.push(`Temp baja >${cfg.tol.toFixed(1)}°C bajo setback`);
    }
  }

  // RH evaluation always applies
  let rhSt = DT_STATUS.OK;
  if (r.rh > cfg.hrAlarm){
    rhSt = DT_STATUS.ALARM; reasons.push(`HR>${cfg.hrAlarm}%`);
  } else if (r.rh > cfg.hrWarn){
    rhSt = DT_STATUS.WARN; reasons.push(`HR>${cfg.hrWarn}%`);
  }

  st = worstStatus(st, rhSt);
  if (!reasons.length) reasons.push('OK');

  return { status: st, reason: reasons.join(' · '), activeSetpoint: sp, reading: r };
}


function statusToColorHex(status){
  if (status === DT_STATUS.OK) return 0x18c964;      // green
  if (status === DT_STATUS.WARN) return 0xf5a524;    // amber
  if (status === DT_STATUS.ALARM) return 0xf31260;   // red
  return 0x6b7280; // gray for none
}


// ===== Panel de alertas (abajo-izquierda) =====
function ensureDtAlertsWrap(){
  let wrap = document.getElementById('dtAlertsWrap');
  if (!wrap){
    wrap = document.createElement('div');
    wrap.id = 'dtAlertsWrap';
    wrap.className = 'dt-alerts-wrap';
    wrap.setAttribute('aria-live','polite');
    wrap.setAttribute('aria-atomic','true');
    document.body.appendChild(wrap);
  }
  return wrap;
}

function getSpaceWorldCenter(spaceId){
  const sp = spaces.get(spaceId);
  if (!sp || !sp.mesh) return null;
  const box = new THREE.Box3().setFromObject(sp.mesh);
  if (box.isEmpty()) return null;
  const c = new THREE.Vector3();
  box.getCenter(c);
  return c;
}

function goToSpace(spaceId){
  // select only this space
  if (typeof selectedIds !== 'undefined'){
    selectedIds.clear();
    selectedIds.add(spaceId);
    if (typeof syncDropdownFromSelection === 'function') syncDropdownFromSelection();
    if (typeof onSelectionChanged === 'function') onSelectionChanged(false, true);
  }
  // frame
  const sp = spaces.get(spaceId);
  if (sp && sp.mesh && typeof frameObject === 'function') frameObject(sp.mesh);

  // open popover at center
  const pt = getSpaceWorldCenter(spaceId);
  if (pt && typeof showPopover === 'function') showPopover(spaceId, pt);
}

function updateDtAlertsPanel(){
  const wrap = ensureDtAlertsWrap();
  if (!spaces || spaces.size === 0){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  const items = [];
  for (const sp of spaces.values()){
    const st = evalSpaceStatus(sp.id);
    if (st.status === DT_STATUS.WARN || st.status === DT_STATUS.ALARM){
      items.push({
        id: sp.id,
        name: sp.name || sp.id,
        status: st.status,
        reason: st.reason || ''
      });
    }
  }

  if (!items.length){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  // order: ALARM first, then WARN; then by name
  items.sort((a,b)=>{
    if (a.status !== b.status) return (a.status === DT_STATUS.ALARM ? -1 : 1);
    return a.name.localeCompare(b.name);
  });

  // show top 4 to keep it lightweight
  const top = items.slice(0, 4);

  wrap.innerHTML = '';
  for (const it of top){
    const el = document.createElement('div');
    el.className = 'dt-alert-item';
    el.setAttribute('role','button');
    el.tabIndex = 0;

    const badge = document.createElement('span');
    badge.className = 'dt-alert-badge';
    badge.style.background = it.status === DT_STATUS.ALARM ? '#ef4444' : '#f59e0b';

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'dt-alert-title';
    title.textContent = it.status === DT_STATUS.ALARM ? `ALARMA · ${it.name}` : `AVISO · ${it.name}`;

    const msg = document.createElement('div');
    msg.className = 'dt-alert-msg';
    msg.textContent = it.reason || 'Revisar';

    body.appendChild(title);
    body.appendChild(msg);

    el.appendChild(badge);
    el.appendChild(body);

    const activate = ()=> goToSpace(it.id);
    el.addEventListener('click', (e)=>{ e.stopPropagation(); activate(); });
    el.addEventListener('keydown', (e)=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });

    wrap.appendChild(el);
  }
  wrap.style.display = 'grid';
}

function applyDtColors(){
  // Always compute and store DT base colors.
  // If there is an active selection, we keep the selection highlight visible,
  // but still refresh the stored _dtBaseColor so it will be correct when deselecting.
  const hasSel = (typeof selectedIds !== 'undefined' && selectedIds.size > 0);
  for (const sp of spaces.values()){
    const { status } = evalSpaceStatus(sp.id);
    const col = statusToColorHex(status);
    sp._dtBaseColor = col;

    if (!hasSel){
      sp.mesh.material.color.setHex(col);
      sp.mesh.material.opacity = 0.35;
      sp.mesh.material.needsUpdate = true;
    }
  }
  // Update markers to reflect LIVE freshness etc.
  if (typeof renderSensorMarkers === 'function') renderSensorMarkers();  if (typeof updateDtAlertsPanel === 'function') updateDtAlertsPanel();
}

function applyAlarmColorsIfNoSelection(){
  // Backwards-compat wrapper
  applyDtColors();
}

// Simple "S" sprite marker for spaces with sensor
// - CSV sensors: "S" normal
// - LIVE sensors: "S" brighter + status color, plus a small "LIVE" label sprite
const SENSOR_POLL_MS = 10000; // must match startLive interval
const LIVE_OK_MS = SENSOR_POLL_MS * 2;
const LIVE_STALE_MS = SENSOR_POLL_MS * 3;

const sensorMarkerTextures = {}; // cache by key

function makeMarkerTexture({ text='S', bg='#078a58', border='#ffffff', glow=false, w=64, h=64, font='bold 30px system-ui, Arial' }){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,w,h);

  if (glow){
    ctx.beginPath();
    ctx.arc(w/2, h/2, Math.min(w,h)*0.44, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(w/2, h/2, Math.min(w,h)*0.40, 0, Math.PI*2);
  ctx.fillStyle = bg;
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.strokeStyle = border;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = font;
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  ctx.fillText(text, w/2, h/2 + 2);

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function getMarkerTexture(key){
  if (sensorMarkerTextures[key]) return sensorMarkerTextures[key];

  if (key === 'csv'){
    sensorMarkerTextures[key] = makeMarkerTexture({ bg:'rgba(7,138,88,0.95)', glow:false });
  } else if (key === 'live_ok'){
    sensorMarkerTextures[key] = makeMarkerTexture({ bg:'rgba(34,197,94,0.98)', glow:true });
  } else if (key === 'live_stale'){
    sensorMarkerTextures[key] = makeMarkerTexture({ bg:'rgba(245,158,11,0.98)', glow:true });
  } else if (key === 'live_err'){
    sensorMarkerTextures[key] = makeMarkerTexture({ bg:'rgba(239,68,68,0.98)', glow:true });
  } else if (key === 'live_label'){
    // small pill label "LIVE"
    const c = document.createElement('canvas');
    c.width = 128; c.height = 44;
    const ctx = c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    const r = 10;
    ctx.beginPath();
    ctx.moveTo(r,0);
    ctx.lineTo(c.width-r,0);
    ctx.quadraticCurveTo(c.width,0,c.width,r);
    ctx.lineTo(c.width,c.height-r);
    ctx.quadraticCurveTo(c.width,c.height,c.width-r,c.height);
    ctx.lineTo(r,c.height);
    ctx.quadraticCurveTo(0,c.height,0,c.height-r);
    ctx.lineTo(0,r);
    ctx.quadraticCurveTo(0,0,r,0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(17,24,39,0.90)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px system-ui, Arial';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.fillText('LIVE', c.width/2, c.height/2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    sensorMarkerTextures[key] = tex;
  } else {
    sensorMarkerTextures[key] = makeMarkerTexture({ bg:'rgba(107,114,128,0.95)', glow:false });
  }

  return sensorMarkerTextures[key];
}

function getLiveMarkerKeyForSensor(sensor){
  if (!sensor || !sensor.data || !sensor.data.length) return 'live_err';
  const last = sensor.data[sensor.data.length - 1];
  const age = Date.now() - last.t.getTime();
  if (age <= LIVE_OK_MS) return 'live_ok';
  if (age <= LIVE_STALE_MS) return 'live_stale';
  return 'live_err';
}

function updateMarkerPositionForSpace(sp){
  if (!sp || !sp.mesh) return new THREE.Vector3();
  sp.mesh.geometry.computeBoundingBox();
  const bb = sp.mesh.geometry.boundingBox;
  const center = new THREE.Vector3();
  bb.getCenter(center);
  center.applyMatrix4(sp.mesh.matrixWorld);
  return center;
}

function ensureSensorMarkerSprites(spaceId){
  const sp = spaces.get(spaceId);
  if (!sp) return;

  if (!sp._sensorSprite){
    const mat = new THREE.SpriteMaterial({ map: getMarkerTexture('csv'), transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.6,0.6,0.6);
    sprite.renderOrder = 9999;
    scene.add(sprite);
    sp._sensorSprite = sprite;
  }
  if (!sp._liveLabelSprite){
    const mat2 = new THREE.SpriteMaterial({ map: getMarkerTexture('live_label'), transparent: true, depthTest: false });
    const sprite2 = new THREE.Sprite(mat2);
    sprite2.scale.set(0.95,0.33,0.95);
    sprite2.renderOrder = 9999;
    scene.add(sprite2);
    sp._liveLabelSprite = sprite2;
  }
}

function renderSensorMarkers(){
  const show = (typeof selectedIds !== 'undefined' && selectedIds.size === 0);

  for (const sp of spaces.values()){
    const sensorId = telemetryState.spaceToSensor[sp.id];
    if (!sensorId){
      if (sp._sensorSprite) sp._sensorSprite.visible = false;
      if (sp._liveLabelSprite) sp._liveLabelSprite.visible = false;
      continue;
    }

    const sensor = telemetryState.sensors[sensorId];
    const isLive = !!(sensor && sensor.source === 'live');

    ensureSensorMarkerSprites(sp.id);

    // choose marker texture
    const key = isLive ? getLiveMarkerKeyForSensor(sensor) : 'csv';
    sp._sensorSprite.material.map = getMarkerTexture(key);
    sp._sensorSprite.material.needsUpdate = true;

    // position marker at space center (+offset)
    const c = updateMarkerPositionForSpace(sp);
    sp._sensorSprite.position.copy(c).add(new THREE.Vector3(0, 0.4, 0));
    sp._sensorSprite.visible = show;

    // LIVE label
    if (isLive){
      sp._liveLabelSprite.position.copy(c).add(new THREE.Vector3(0.55, 0.4, 0));
      sp._liveLabelSprite.visible = show;
    } else {
      sp._liveLabelSprite.visible = false;
    }
  }
}

function updateSensorSpritesVisibility(){
  // Backwards-compat wrapper
  renderSensorMarkers();
}



// UI telemetría
const btnImportCsv = document.getElementById('btnImportCsv');
const csvFileEl    = document.getElementById('csvFile');
const selSensorEl  = document.getElementById('selSensor');
const btnAssignSensorEl = document.getElementById('btnAssignSensor');
const selRangeEl   = document.getElementById('selRange');
const telemetrySummaryEl = document.getElementById('telemetrySummary');
const svgTempEl    = document.getElementById('svgTemp');
const svgRhEl      = document.getElementById('svgRh');

// === SYNLIVE (modo sensores en vivo desde un backend local) ===
// El backend debe exponer: GET {base}/api/sensors/latest -> [{sensorId,name,temp,rh,ts}]
const liveDotEl   = document.getElementById('liveDot');
const chkLiveEl   = document.getElementById('chkLive');
const liveBaseEl  = document.getElementById('liveBase');
const btnLiveTestEl = document.getElementById('btnLiveTest');
const liveMsgEl   = document.getElementById('liveMsg');

let liveTimer = null;
let lastLiveOkMs = 0;
let lastLiveErr = '';

function setLiveDot(state){
  if (!liveDotEl) return;
  // state: 'off' | 'ok' | 'stale' | 'err'
  const c = state === 'ok' ? '#22c55e' : state === 'stale' ? '#f59e0b' : state === 'err' ? '#ef4444' : '#6b7280';
  liveDotEl.style.background = c;
}

function loadLiveCfg(){
  try{
    const raw = localStorage.getItem('SYNLIVE_CFG');
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (liveBaseEl && cfg.base) liveBaseEl.value = cfg.base;
    if (chkLiveEl && typeof cfg.enabled === 'boolean') chkLiveEl.checked = cfg.enabled;
  } catch {}
}

function saveLiveCfg(){
  try{
    const cfg = { base: liveBaseEl?.value || '', enabled: !!chkLiveEl?.checked };
    localStorage.setItem('SYNLIVE_CFG', JSON.stringify(cfg));
  } catch {}
}

function upsertLiveReading(reading){
  const id = String(reading.sensorId || '').trim();
  if (!id) return;
  const t = new Date(reading.ts);
  if (Number.isNaN(t.getTime())) return;

  const temp = Number(reading.temp);
  const rh   = Number(reading.rh);

  if (!telemetryState.sensors[id]) {
    telemetryState.sensors[id] = { id, name: reading.name || id, data: [], source: 'live' };
  }
  const s = telemetryState.sensors[id];
  s.source = 'live';
  if (reading.name) s.name = reading.name;

  const last = s.data.length ? s.data[s.data.length - 1] : null;
  if (!last || last.t.getTime() !== t.getTime()) {
    s.data.push({ t, temp, rh });
    if (s.data.length > 5000) s.data.shift();
  }
}

async function fetchLiveLatest(){
  const base = (liveBaseEl?.value || '').replace(/\/$/, '');
  if (!base) throw new Error('Base URL vacía');
  const url = base + '/api/sensors/latest';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('Respuesta no es array');
  arr.forEach(upsertLiveReading);

  lastLiveOkMs = Date.now();
  lastLiveErr = '';
  refreshSensorSelect();

  // Refresh DT status & visuals on every poll
  applyDtColors();
  renderSensorMarkers();
  updatePopoverContentFromTelemetry();
}

function startLive(){
  stopLive();
  setLiveDot('stale');
  saveLiveCfg();
  if (liveMsgEl) liveMsgEl.textContent = 'Live activado. Leyendo /api/sensors/latest...';
  // primer fetch inmediato y luego cada 10s
  fetchLiveLatest().catch(err=>{
    lastLiveErr = String(err?.message || err);
    if (liveMsgEl) liveMsgEl.textContent = 'Live error: ' + lastLiveErr;
    setLiveDot('err');
  });
  liveTimer = setInterval(()=>{
    fetchLiveLatest().catch(err=>{
      lastLiveErr = String(err?.message || err);
      if (liveMsgEl) liveMsgEl.textContent = 'Live error: ' + lastLiveErr;
      setLiveDot('err');
    });
    // estado stale si hace mucho que no llega
    const age = Date.now() - lastLiveOkMs;
    if (lastLiveOkMs && age > 25000 && !lastLiveErr) setLiveDot('stale');
    if (!lastLiveErr && lastLiveOkMs) setLiveDot('ok');
  }, 10000);
}

function stopLive(){
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (liveMsgEl) liveMsgEl.textContent = 'Live desactivado.';
  setLiveDot('off');
  saveLiveCfg();
}

if (btnLiveTestEl) {
  btnLiveTestEl.addEventListener('click', async ()=>{
    saveLiveCfg();
    if (liveMsgEl) liveMsgEl.textContent = 'Probando...';
    try{
      await fetchLiveLatest();
      setLiveDot('ok');
      if (liveMsgEl) liveMsgEl.textContent = 'Conexión OK. Sensores detectados: ' + Object.keys(telemetryState.sensors).length;
    } catch(err){
      lastLiveErr = String(err?.message || err);
      setLiveDot('err');
      if (liveMsgEl) liveMsgEl.textContent = 'Error: ' + lastLiveErr;
    }
  });
}

if (chkLiveEl) {
  chkLiveEl.addEventListener('change', ()=>{
    saveLiveCfg();
    if (chkLiveEl.checked) startLive();
    else stopLive();
  });
}

// carga config al arrancar
loadLiveCfg();
if (chkLiveEl?.checked) startLive();


// Cerramientos

const selAsmWall  = document.getElementById('selAsmWall');
const selAsmRoof  = document.getElementById('selAsmRoof');
const selAsmFloor = document.getElementById('selAsmFloor');
const selAsmWin   = document.getElementById('selAsmWin');

// Datos por espacio
// id -> { id, name, zoneId, mesh, edges, color,
//         area_total_m2, area_floor_m2, area_roof_m2, area_walls_m2, volume_m3, triCount,
//         params: { dT, Uwall, Uroof, Ufloor, Awin, Uwin, people, ltg_Wm2, equip_Wm2 } }
const spaces = new Map();
const meshToSpace = new Map();

// --- Wait mode (auto-orbit tras inactividad) ---
let idleTimer = null;
const IDLE_DELAY_MS = 5000;      // ⏱️ 5 s sin interacción
const AUTO_ORBIT_SPEED = 2.5;     // 🔁 velocidad (signo + = horario, - = antihorario)

init();

function init() {
  // Render
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x0b0e1a, 1);
  viewerEl.appendChild(renderer.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(10, 20, 10);
  scene.add(dir);

  // Camera & controls (THREE r134 UMD)
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1e9);
  camera.position.set(20, 20, 24);
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 2, 0);

  // Eventos de "actividad" para reiniciar el temporizador
  const activityEvents = ['pointerdown','pointermove','wheel','keydown','touchstart','touchmove'];
  activityEvents.forEach(ev => window.addEventListener(ev, resetIdleTimer, { passive: true }));

  // Arranca el temporizador desde ya
  resetIdleTimer();
  const sidePanel = document.getElementById('sidePanel');
  sidePanel?.classList.add('collapsed');  // arranque abierto

  scene.add(rootGroup);
  scene.add(edgesGroup);
  scene.add(windowsGroup);

  const chkWindowsEl = document.getElementById('chkWindows'); 
  chkWindowsEl.addEventListener('change', () => windowsGroup.visible = chkWindowsEl.checked); 
  windowsGroup.visible = chkWindowsEl.checked; 

  // Picking
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  viewerEl.addEventListener('pointerdown', onPointerDown);

  // Clic en el resumen -> abre/cierra la lista
  selectionSummaryEl?.addEventListener('click', (e) => {
    if (!selectedListEl) return;
    // Render siempre antes de mostrar
    renderSelectedList();
    const isOpen = selectedListEl.style.display !== 'none';
    selectedListEl.style.display = isOpen ? 'none' : '';
    e.stopPropagation();
  });

  // Delegación: clic en una pill -> quitar de la selección
  selectedListEl?.addEventListener('click', (e) => {
    const pill = e.target.closest('.sel-pill');
    if (!pill) return;
    const sid = pill.dataset.sid;
    if (!sid) return;

    // Quitar de la selección
    selectedIds.delete(sid);

    // Sincronizar todo lo demás
    syncDropdownFromSelection();           // actualiza los checkboxes del desplegable
    onSelectionChanged(false, true);       // tu recalculo de sumas/inputs
    updateSelectionSummaryUI();            // actualiza contador / oculta si 0
    renderSelectedList();                  // refresca la lista visible

    // Si al quitar queda 1 seleccionado, puedes abrir su ficha:
    if (selectedIds.size === 1) {
      const only = [...selectedIds][0];
      selSpaceEl.value = only;
      highlightSpace(only);
    }
  });

  document.getElementById('btnHideSel')?.addEventListener('click', () => {
  if (selectedIds.size === 0) return;
  hideSpaces([...selectedIds]);
  });

  document.getElementById('btnIsolateSel')?.addEventListener('click', () => {
    if (selectedIds.size === 0) return;
    isolateSelected();
  });

  document.getElementById('btnShowAll')?.addEventListener('click', () => {
    showAllSpaces();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target && (/input|select|textarea/i).test(e.target.tagName)) return; // no molestar al escribir
    if (e.key.toLowerCase() === 'h') {            // H = ocultar seleccionados
      if (selectedIds.size) hideSpaces([...selectedIds]);
    } else if (e.key.toLowerCase() === 'i') {     // I = aislar seleccionados
      if (selectedIds.size) isolateSelected();
    } else if (e.key.toLowerCase() === 'a') {     // A = mostrar todo
      showAllSpaces();
    }
  });

  // UI
  window.addEventListener('resize', onResize);
  // Botón bonito -> dispara el input oculto
  btnImportGbxml?.addEventListener('click', () => fileEl?.click());
  // Cuando el usuario elige archivo
  fileEl?.addEventListener('change', async () => {
    const f = fileEl.files?.[0];
    if (!f) return;

    // Validación rápida de extensión
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext !== 'xml' && ext !== 'gbxml') {
      alert('Por favor, selecciona un archivo .gbxml o .xml');
      fileEl.value = '';
      return;
      
    }

    try {
      const text = await f.text();
      lastGbxmlText = text;
      currentGbxmlInfo = {
      fileName: f.name || 'model.gbxml',
      sha256: await sha256(text),
      loadedAt: Date.now()
    };

    loadGbxml(text); // renderiza
      // (Opcional) feedback en UI:
      console.info(`Cargado: ${f.name} (${(f.size/1024).toFixed(1)} KB)`);
    } catch (err) {
      alert('No se pudo leer el archivo: ' + err);
    } finally {
      // Limpia para poder volver a elegir el mismo archivo si hace falta
      fileEl.value = '';
    }
  });
  btnReset.addEventListener('click', frameAll);
  chkEdgesEl.addEventListener('change', () => {
  edgesGroup.visible = chkEdgesEl.checked;
  });


  function applyVisToSpace(sp, visible) {
  if (!sp) return;
  sp.mesh.visible = !!visible;
  if (sp.edges) sp.edges.visible = !!visible && chkEdgesEl.checked;

  // marca estado lógico y limpia selección si se oculta
  if (!visible) {
    hiddenIds.add(sp.id);
    selectedIds.delete(sp.id);
  } else {
    hiddenIds.delete(sp.id);
  }

  // si tienes un item del dropdown, desactívalo visualmente
  const row = ddList?.querySelector(`.dd-item[data-space-id="${sp.id}"]`);
  if (row) row.classList.toggle('is-hidden', !visible); // CSS abajo
  }


  // Ocultar espacios por id[]
  function hideSpaces(ids) {
    ids.forEach(id => {
      const sp = spaces.get(id);
      applyVisToSpace(sp, false);
    });
  }

  // Mostrar espacios por id[]
  function showSpaces(ids) {
    ids.forEach(id => {
      const sp = spaces.get(id);
      applyVisToSpace(sp, true);
    });
  }

  // Aislar: sólo seleccionados visibles
  function isolateSelected() {
    const sel = [...selectedIds];
    for (const sp of spaces.values()) {
      const v = selectedIds.has(sp.id);
      applyVisToSpace(sp, v);
    }
  }

  // Mostrar todo
  function showAllSpaces() {
    for (const sp of spaces.values()) applyVisToSpace(sp, true);
  }


  // --- Helper de toasts ---
  function ensureToastWrap() {
    let wrap = document.getElementById('toastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toastWrap';
      wrap.className = 'toast-wrap';
      wrap.setAttribute('aria-live', 'polite');
      wrap.setAttribute('aria-atomic', 'true');
      document.body.appendChild(wrap);
    }
    return wrap;
  }


  function showToast(message, type = 'info', { duration = 2600 } = {}) {
    const wrap = ensureToastWrap();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;

    wrap.appendChild(el);

    // forzar reflow para activar transición
    void el.offsetWidth;
    el.classList.add('show');

    // auto-cerrar
    const hide = () => {
      el.classList.remove('show');
      const removeDelay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250;
      setTimeout(() => el.remove(), removeDelay);
    };

    const timer = setTimeout(hide, duration);

    // cerrar al clic
    el.addEventListener('click', () => {
      clearTimeout(timer);
      hide();
    });
  }


  // ====== INICIO ======
  const IndexLink = document.getElementById("btnInicio").addEventListener("click", () => {
  window.location.href = "../index.html";
  });
  

  // ====== NUEVO PROYECTO ======
  document.getElementById("btnNewProject").addEventListener("click", () => {
  window.location.href = "modeller.html";
  });

  // ====== GUARDAR PROYECTO ======
  document.getElementById('btnSaveProject')?.addEventListener('click', () => {
  try {
    const snap = buildProjectSnapshot();
    const json = JSON.stringify(snap, null, 2);
    const base = (currentGbxmlInfo.fileName || 'model').replace(/\.[^.]+$/,'');
    downloadBlob(json, `${base}.syngala.json`);
    // Pequeña pausa para dejar que el navegador descargue antes de salir
    showToast('Proyecto guardado correctamente ✅', 'success');
  } catch (err) {
    console.error(err);
    showToast('No se pudo guardar el proyecto ❌', 'error');
  }
  });

  // ====== CARGAR PROYECTO ======
  const projectLoadInput = document.getElementById('projectLoadInput');

  document.getElementById('btnLoadProject')?.addEventListener('click', () => {
    projectLoadInput?.click(); // abre selector de archivo
  });

  projectLoadInput?.addEventListener('change', async () => {
    const f = projectLoadInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const snap = JSON.parse(text);
      await restoreProjectSnapshot(snap);
      showToast('Proyecto cargado correctamente ✅', 'success');
    } catch (err) {
      console.error(err);
      showToast('Proyecto inválido ❌', 'error');
    } finally {
      projectLoadInput.value = '';
    }
  });


  edgesGroup.visible = chkEdgesEl.checked; // estado inicial correcto
  selSpaceEl.addEventListener('change', () => {
  const id = selSpaceEl.value;
  if (id) {
    document.getElementById('sidePanel').classList.remove('open'); // abre panel
    expandPanel({ keepDropdownOpen: true });
    selectSingle(id);
  }
  });

  unitSelectEl.addEventListener('change', () => {
    updateDerivedOutputs(); // deja que la función detecte multi/único
  });

    // Abrir/cerrar panel
    ddToggle.addEventListener('click', () => {
    ddRoot.classList.toggle('open');
    });
    // Despliega al seleccionar espacios si está colapsado:
    ddToggle.addEventListener('click', (e) => {
      const sidePanel = document.getElementById('sidePanel');
      if (sidePanel?.classList.contains('collapsed')) {
        sidePanel.classList.remove('collapsed');
        // Mantén el dropdown abierto tras expandir
        expandPanel?.({ keepDropdownOpen: true });
        // Si tu dropdown necesita reposicionarse:
        if (typeof positionDropdown === 'function') positionDropdown();
        e.stopPropagation();
      }
    });

    // ====== Shortcut: 'z' → Zoom out genérico (sin limpiar selección) ======
      window.addEventListener('keydown', (e) => {
        // no molestar cuando se escribe en inputs/select/textarea o contenido editable
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

        // evita conflicto con Ctrl+Z / Cmd+Z (deshacer)
        if (e.ctrlKey || e.metaKey) return;

        if (!e.repeat && e.key && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          // usa tu helper existente; no toca selectedIds
          zoomOutGeneric();
        }
      });

      // ===========SIMULADOR DE CERRAMIENTOS=================

      window.addEventListener('message', (ev) => {
        const { type } = ev.data || {};
        if (type === 'assemblies:request_init') {
          const payload = { assemblies: projectState.assemblies };
          ev.source?.postMessage({ type: 'assemblies:init', payload }, '*');
        }
      });
      let assembliesWin = null;
      

     document.getElementById('btnAssemblies')?.addEventListener('click', async () => {
      // 1) Asegura que hay materiales cargados
      if (!projectState.assemblies || !projectState.assemblies.materials || !Object.keys(projectState.assemblies.materials).length) {
        try {
          const asm = await fetch('assemblies_from_xls.json').then(r => r.json());
          projectState.assemblies = asm;
        } catch (err) {
          alert('No se pudo cargar assemblies_from_xls.json: ' + err);
          return;
        }
      }

      // 2) Abre subventana
      assembliesWin = window.open('./aaa.html', 'assemblies', 'width=1100,height=780');

      // 3) Handshake: envía estado al editor
      const payload = { assemblies: projectState.assemblies };
      const trySend = () => assembliesWin?.postMessage({ type: 'assemblies:init', payload }, '*');
      setTimeout(trySend, 500);
    });
    
    window.addEventListener('message', (ev) => {
    const { type, payload } = ev.data || {};
    if (type === 'assemblies:update') {
      // payload = { materials, opaque, windows }
      projectState.assemblies = payload;
      refreshAssemblySelectors(); // repinta selects de asignación si los tienes
    }
  });

  function refreshAssemblySelectors() {
    const A = projectState.assemblies || { opaque:{}, windows:{} };
    fillSelect(selAsmWall,  Object.values(A.opaque).filter(a => a.type === 'wall'));
    fillSelect(selAsmRoof,  Object.values(A.opaque).filter(a => a.type === 'roof'));
    fillSelect(selAsmFloor, Object.values(A.opaque).filter(a => a.type === 'floor'));
    fillSelect(selAsmWin,   Object.values(A.windows));
  }
  function fillSelect(sel, arr) {
    if (!sel) return;
    sel.innerHTML = '<option value="">—</option>'
                  + arr.map(a => `<option value="${a.id}">${a.name} (${a.id})</option>`).join('');
  }

  // Al cargar modelo por primera vez, llama:
  refreshAssemblySelectors();

  document.getElementById('btnApplyAsm')?.addEventListener('click', () => {
    if (selectedIds.size === 0) return;

    const w   = selAsmWall.value  || undefined;
    const r   = selAsmRoof.value  || undefined;
    const f   = selAsmFloor.value || undefined;
    const win = selAsmWin.value   || undefined;

    for (const id of selectedIds) {
      projectState.assignments[id] = projectState.assignments[id] || {};
      if (w)   projectState.assignments[id].wall   = w;
      if (r)   projectState.assignments[id].roof   = r;
      if (f)   projectState.assignments[id].floor  = f;
      if (win) projectState.assignments[id].window = win;

      // (Opcional) Sincroniza U-values visibles con los de la construction:
      const sp = spaces.get(id);
      if (!sp) continue;
      if (w)   sp.params.Uwall  = projectState.assemblies.opaque[w]?.u_Wm2K ?? sp.params.Uwall;
      if (r)   sp.params.Uroof  = projectState.assemblies.opaque[r]?.u_Wm2K ?? sp.params.Uroof;
      if (f)   sp.params.Ufloor = projectState.assemblies.opaque[f]?.u_Wm2K ?? sp.params.Ufloor;
      if (win) sp.params.Uwin   = projectState.assemblies.windows[win]?.U_Wm2K ?? sp.params.Uwin;
    }

    updateDerivedOutputs(selectedIds.size === 1 ? [...selectedIds][0] : '');
  });

      // ================= FIN SIMULADOR CERRAMIENTOS ========================


    // Cerrar al clicar fuera
    document.addEventListener('click', (e) => {
      if (!ddRoot) return;
      if (ddRoot.contains(e.target)) return; // click dentro → no cerrar
      ddRoot.classList.remove('open');       // click fuera → cerrar
    });
    //cerrar al pulsar Escape
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') ddRoot.classList.remove('open');
    });
    // Filtro
    ddFilter.addEventListener('input', () => {
      const q = ddFilter.value.toLowerCase();
      ddList.querySelectorAll('.dd-item').forEach(item => {
        const txt = item.dataset.label || '';
        item.style.display = txt.includes(q) ? '' : 'none';
      });
    });
    // Acciones rápidas
    ddSelAll.addEventListener('click', () => {
      for (const sp of spaces.values()) selectedIds.add(sp.id);
      syncDropdownFromSelection();
      onSelectionChanged(false, true); // mantener abierto
    });
    ddSelNone.addEventListener('click', () => {
      selectedIds.clear();
      syncDropdownFromSelection();
      onSelectionChanged(true, true); // mantener abierto
    });

  // Inputs -> recalcular
 [inDT, inPeople, inLtg, inEquip].forEach(el => {
  el.addEventListener('input', () => {
    if (selectedIds.size === 0) return; // nada seleccionado

    // Aplica a todos los seleccionados
    for (const id of selectedIds) {
      const sp = spaces.get(id);
      if (!sp) continue;
      sp.params.dT        = toNum(inDT.value);
      sp.params.people    = Math.max(0, Math.floor(toNum(inPeople.value)));
      sp.params.ltg_Wm2   = toNum(inLtg.value);
      sp.params.equip_Wm2 = toNum(inEquip.value);
    }

    // Refresca salidas: si solo hay 1, usa su cálculo; si hay varias, podríamos mostrar totales más adelante.
    if (selectedIds.size === 1) {
      updateDerivedOutputs([...selectedIds][0]);
    } else {
      // Multi → deja “—” o un mensaje. Opcional: sumar totales a futuro.
      elQTrans.textContent = elQInt.textContent = elQTot.textContent = '—';
    }
  });
});

  // ====== Telemetría UI ======
  btnImportCsv?.addEventListener('click', () => csvFileEl?.click());

  csvFileEl?.addEventListener('change', async () => {
    const f = csvFileEl.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = parseSwitchBotCsv(text, f.name.replace(/\.csv$/i,''));
      const id = 'sb_' + Date.now();
      telemetryState.sensors[id] = { id, name: parsed.name, data: parsed.data, source: 'csv' };
      refreshSensorSelect();
      selSensorEl.value = id;

      // auto-assign si hay 1 espacio seleccionado
      if (selectedIds.size === 1) {
        const spaceId = [...selectedIds][0];
        telemetryState.spaceToSensor[spaceId] = id;
      }

      showToast?.(`CSV importado: ${parsed.name} (${parsed.data.length} puntos) ✅`, 'success');
      renderTelemetryForSelection();
      applyAlarmColorsIfNoSelection();
    } catch (err) {
      console.error(err);
      alert('No se pudo importar el CSV: ' + (err?.message || err));
    } finally {
      csvFileEl.value = '';
    }
  });

  btnAssignSensorEl?.addEventListener('click', () => {
    if (selectedIds.size !== 1) {
      showToast?.('Selecciona 1 espacio para asignar un sensor', 'info');
      return;
    }
    const sensorId = selSensorEl?.value;
    if (!sensorId) {
      showToast?.('Primero elige un sensor (o importa un CSV)', 'info');
      return;
    }
    const spaceId = [...selectedIds][0];
    telemetryState.spaceToSensor[spaceId] = sensorId;
    showToast?.('Sensor asignado al espacio ✅', 'success');
    renderTelemetryForSelection();
    applyAlarmColorsIfNoSelection();
  });

  selSensorEl?.addEventListener('change', () => renderTelemetryForSelection());
  selRangeEl?.addEventListener('change', () => renderTelemetryForSelection());


  animate();
}

const spaceTypeEl = document.getElementById('space_type');
spaceTypeEl.addEventListener('change', () => {
  if (selectedIds.size === 0) return;
  for (const id of selectedIds) {
    const sp = spaces.get(id);
    if (!sp) continue;
    sp.params.spaceType = spaceTypeEl.value;
  }
  // si hay 1 seleccionado, refrescamos panel
  if (selectedIds.size === 1) updateDerivedOutputs([...selectedIds][0]);
});


function animate() {
  requestAnimationFrame(animate);
  controls.update();
  TWEEN.update();
  updatePopoverPosition();
  renderer.render(scene, camera);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

let currentGbxmlInfo = { fileName: '', sha256: '', loadedAt: 0 };
// Guarda el texto del gbXML para poder exportarlo en el proyecto
let lastGbxmlText = '';
async function onFileSelected() {
  const f = fileEl.files?.[0];
  if (!f) return;
  const text = await f.text();
  currentGbxmlInfo = {
    fileName: f.name || 'model.gbxml',
    sha256: await sha256(text),
    loadedAt: Date.now()
  };
  lastGbxmlText = text; 
  loadGbxml(text);
  
}

function loadGbxml(xmlText) {
   // Si venimos de proyecto (embedded) o ya se estableció fuera, NO lo pises.
  if (!currentGbxmlInfo.fileName) {
    currentGbxmlInfo = {
      fileName: 'model.gbxml',
      importedAt: new Date().toISOString()
    };
  }
  // Por si llamado a loadGbxml con texto y aún no estaba cacheado:
  if (!lastGbxmlText) {
    lastGbxmlText = xmlText;
  }
  // Reset
  for (const s of spaces.values()) {
    if (s.mesh) rootGroup.remove(s.mesh);
    if (s.edges) edgesGroup.remove(s.edges);
  }
  spaces.clear();
  meshToSpace.clear();
  rootGroup.clear();
  edgesGroup.clear();
  windowsGroup.clear(); 
  selSpaceEl.innerHTML = '';
  spaceInfoEl.innerHTML = '<div class="kv"><span>Cargando…</span></div>';
  

  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');

  const nodeSpaces = getByLocalName(xml, 'Space');
  if (!nodeSpaces.length) {
    spaceInfoEl.innerHTML = '<div class="kv"><span>No se encontraron &lt;Space&gt;.</span></div>';
    return;
  }

  let built = 0;
  for (const spEl of nodeSpaces) {
    const id = spEl.getAttribute('id') || '';
    const name = getTextByLocalName(spEl, 'Name') || id || 'Space';
    const zoneId = spEl.getAttribute('zoneIdRef') || getTextByLocalName(spEl, 'ZoneIdRef') || '';

    const polyloops = getSpacePolyLoops(spEl);
    if (!polyloops.length) continue;

    // Triangulación + áreas por cara
    const facePack = triangulateClosedShellWithFaceInfo(polyloops);
    const geometry = facePack.geometry;

    // Derivar Floor/Roof/Walls/Total
    const areas = deriveAreas(facePack);
    const volume_m3 = computeMeshVolume(geometry);

    const color = colorFromString(id || name);
    const material = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    rootGroup.add(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({}));
    edges.visible = chkEdgesEl.checked; // ✔ correcto
    edgesGroup.add(edges);


    // Defaults de cargas (SI)
    const params = {
      dT: 10, Uwall: 0.60, Uroof: 0.30, Ufloor: 0.45,
      Uwin: 2.60,
      people: 0, ltg_Wm2: 8, equip_Wm2: 10,
      spaceType: 'No Asignado' // valor por defecto; elige el que prefieras
    };

    spaces.set(id, {
      id, name, zoneId, color, mesh, edges,
      area_total_m2: areas.total,
      area_floor_m2: areas.floor,
      area_roof_m2:  areas.roof,
      area_walls_m2: areas.walls,
      area_window_m2: 0,           // openings
      area_walls_eff_m2: areas.walls, // walls efectivos (walls - windows) → se recalcula luego
      volume_m3,
      triCount: facePack.triCount,
      params
    });
    meshToSpace.set(mesh.uuid, id);
    built++;
  }

  
  populateSpaceSelect();
  // ✅ Cargar ventanas tras poblar espacios
  addOpeningsFromXml(xml);
  // ✅ calcular áreas de ventanas por espacio y ajustar walls efectivos
  accumulateWindowAreasPerSpace(xml);
  zoomOutGeneric();
  
  //frameAll();
  document.getElementById('sidePanel').classList.add('collapsed'); // Cerrar tras carga
  resetIdleTimer(); // tras encuadrar el modelo, programa auto-rotación si no hay interacción
  spaceInfoEl.innerHTML = '<div class="kv"><span>Selecciona un espacio…</span></div>';

  console.info(`[DBG] Espacios construidos: ${built}`);
  
}

function populateSpaceSelect() {
  selSpaceEl.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = '— Selecciona un espacio —';
  selSpaceEl.appendChild(optAll);

  [...spaces.values()]
    .sort((a,b)=> (a.name||'').localeCompare(b.name||''))
    .forEach(sp => {
      const opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = `${sp.name} (${sp.id})`;
      selSpaceEl.appendChild(opt);
    });

    populateSpaceTiles();
    buildSpaceDropdown();
    syncDropdownFromSelection();
    // Orden estable para rangos Shift (por nombre, como el desplegable)
    spaceOrder = [...spaces.values()]
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(sp => sp.id);

}

function populateSpaceTiles() {
  const cont = document.getElementById('spaceTiles');
  if (!cont) return;
  cont.innerHTML = '';
  [...spaces.values()]
    .sort((a,b)=> (a.name||'').localeCompare(b.name||''))
    .forEach(sp => {
      const d = document.createElement('div');
      d.className = 'tile';
      d.dataset.spaceId = sp.id;
      d.innerHTML = `<b>${escapeHtml(sp.name)}</b><small>${escapeHtml(sp.id)}</small>`;
      d.addEventListener('click', () => {
        toggleSelect(sp.id);    // toggle multiselección desde celdas
      });
      cont.appendChild(d);
    });
  syncTiles();
}

function buildSpaceDropdown() {
  if (!ddList) return;
  ddList.innerHTML = '';
  [...spaces.values()]
    .sort((a,b)=> (a.name||'').localeCompare(b.name||''))

    .forEach(sp => {
      const row = document.createElement('div');
      row.className = 'dd-item';
      row.dataset.spaceId = sp.id;
      row.dataset.label   = `${(sp.name||'').toLowerCase()} ${(sp.id||'').toLowerCase()}`;

      const cb  = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedIds.has(sp.id);
      // Evitar que el click cierre el dropdown y capturar modificadores
      // === Helpers para manejar el click en ítem (checkbox, label o fila) ===

          function attachDdItemHandlers(rowEl, cbEl, spaceId) {
            const handle = (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              handleDropdownSelectClick(spaceId, ev);
            };
            
            // Click en checkbox
            cbEl.addEventListener('click', handle, { passive: false });

            // Usa pointerdown en los tres: fila, label e input
            rowEl.addEventListener('pointerdown', handle, { passive: false });
            const lab = rowEl.querySelector('label');
            if (lab) lab.addEventListener('pointerdown', handle, { passive: false });
            cbEl.addEventListener('pointerdown', handle, { passive: false });

            // Mejora UX
            rowEl.style.cursor = 'pointer';
          }

      const lab = document.createElement('label');
      lab.textContent = sp.name || sp.id;

      const small = document.createElement('small');
      small.textContent = ` ${sp.id}`;

      lab.appendChild(small);
      row.appendChild(cb);
      row.appendChild(lab);
      attachDdItemHandlers(row, cb, sp.id);
      ddList.appendChild(row);
    });
}

function syncDropdownFromSelection() {
  // Marca checkboxes
  ddList.querySelectorAll('.dd-item').forEach(item => {
    const id = item.dataset.spaceId;
    const cb = item.querySelector('input[type="checkbox"]');
    cb.checked = selectedIds.has(id); // tick según selección
  });
  // Actualiza texto del botón
  const n = selectedIds.size;
  ddToggle.textContent = n ? `Selecciona espacios (${n})` : 'Selecciona espacios (0)';
}

function highlightSpace(spaceId) {
  const sp = spaces.get(spaceId);
  if (!sp) return;
  // ✅ Si el panel está colapsado, lo expandimos automáticamente
  document.getElementById('sidePanel').classList.remove('collapsed');

  // Resaltar
  for (const s of spaces.values()) {
    const on = (s.id === spaceId);
    s.mesh.material.opacity = on ? (selectedIds.size===0 ? 0.35 : 0.85) : 0.15;
    s.mesh.material.color.setHex(on ? (s._dtBaseColor ?? s.color) : 0x888888);
    s.mesh.material.needsUpdate = true;
  }

  // Rellenar panel
  spaceInfoEl.innerHTML = `
    <div class="kv"><span><b>Nombre</b></span><span class="pill">${escapeHtml(sp.name)}</span></div>
    <div class="kv"><span><b>ID</b></span><span class="pill">${escapeHtml(sp.id)}</span></div>
    <div class="kv"><span>Zona</span><span class="pill">${escapeHtml(sp.zoneId || '—')}</span></div>

  `;

  // Cargar inputs (SI)
  inDT.value      = sp.params.dT;
  inPeople.value  = sp.params.people;
  inLtg.value     = sp.params.ltg_Wm2;
  inEquip.value   = sp.params.equip_Wm2;
  document.getElementById('space_type').value = sp.params.spaceType || 'oficinas';

  updateDerivedOutputs();
  //frameObject(sp.mesh); // zoom
  zoomToMesh(sp.mesh);
  renderTelemetryForSelection();
  resetIdleTimer(); // reinicia temporizador de auto-rotación
}

function getVisibleOrderForRange() {
  return [...ddList.querySelectorAll('.dd-item')]
    .filter(el => el.style.display !== 'none' && !el.classList.contains('is-hidden'))
    .map(el => el.dataset.spaceId);
}

// ejemplo “seleccionar todo del grupo actual”
function selectIds(ids) {
  ids.forEach(id => { if (!hiddenIds.has(id)) selectedIds.add(id); });
  syncDropdownFromSelection(); onSelectionChanged(false, true);
}

function selectRangeBetween(idA, idB, { additive = false } = {}) {
  // Si hay filtros → usa orden visible; si no → orden global por nombre
  const visibleOrder = getVisibleOrderForRange();
  const order = visibleOrder.length ? visibleOrder : spaceOrder;

  const idxA = order.indexOf(idA);
  const idxB = order.indexOf(idB);
  if (idxA === -1 || idxB === -1) return;

  const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
  const rangeIds = order.slice(lo, hi + 1);

  if (!additive) selectedIds.clear();
  for (const sid of rangeIds) selectedIds.add(sid);
}


function handleDropdownSelectClick(id, ev) {
  const ctrl = ev.ctrlKey || ev.metaKey;
  const shift = ev.shiftKey;

  if (shift) {
    // Si NO hay ancla, trata como clic normal
    if (!lastAnchorId) {
      selectedIds.clear();
      selectedIds.add(id);
      lastAnchorId = id; // fija ancla
    } else {
      // Rango entre ancla y actual; si hay Ctrl, suma al existente
      selectRangeBetween(lastAnchorId, id, { additive: ctrl });
      // Comportamiento tipo “lista”: ancla pasa a ser el último clic
      lastAnchorId = id;
    }
  } else if (ctrl) {
    // Ctrl/Cmd: toggle
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    lastAnchorId = id; // actualiza ancla al último clic
  } else {
    // Clic normal: selección única y ancla
    selectedIds.clear();
    selectedIds.add(id);
    lastAnchorId = id;
  }


  // Forzar tick inmediato del clicado (mejor UX; evita carreras)
  const itemEl = ddList.querySelector(`.dd-item[data-space-id="${id}"]`);
  if (itemEl) {
    const cb = itemEl.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = selectedIds.has(id);
  }
  // Mantén dropdown abierto y refresca UI una sola vez
  expandPanel({ keepDropdownOpen: true });
  syncDropdownFromSelection();
  onSelectionChanged(false, true);
  updateSelectionSummaryUI();
}



function updateDerivedOutputs(spaceId = '') {
  // Construye la lista de ids a calcular:
  // - si hay multiselección, usa esa
  // - si no hay, usa el spaceId pasado (selección única)
  const ids = [...(selectedIds.size ? selectedIds : (spaceId ? [spaceId] : []))];
  if (ids.length === 0) {
    elFloor.textContent = elWin.textContent = elTotal.textContent = elVol.textContent = '—';
    elQTrans.textContent = elQInt.textContent = elQTot.textContent = '—';
    return;
  }

  // Unidades
  const unit = unitSelectEl.value; // 'si' | 'ip'
  const areaFactor = unit === 'si' ? 1 : 10.76391041671;
  const volFactor  = unit === 'si' ? 1 : 35.31466672149;
  const powFactor  = unit === 'si' ? 1 : 3.412141633;
  const areaLabel = unit === 'si' ? 'm²' : 'ft²';
  const volLabel  = unit === 'si' ? 'm³' : 'ft³';
  const powLabel  = unit === 'si' ? 'W'  : 'Btu/h';

  // MULTI → sumar
  if (ids.length >= 1) {
    let sumFloor=0, sumTotal=0, sumWin=0, sumVol=0;
    let sumQtrans=0, sumQint=0, sumQtot=0;

    for (const id of ids) {
      const sp = spaces.get(id); if (!sp) continue;
      sumFloor += sp.area_floor_m2;
      sumTotal += sp.area_total_m2;
      sumWin   += sp.area_window_m2 || 0;
      sumVol   += sp.volume_m3;

      const dT = sp.params.dT;
      const Awalls_eff = sp.area_walls_eff_m2 || 0;
      const Aroof      = sp.area_roof_m2      || 0;
      const Afloor     = sp.area_floor_m2     || 0;
      const Awin       = sp.area_window_m2    || 0;
      const Qtrans_SI =
        sp.params.Uwall  * Awalls_eff * dT +
        sp.params.Uroof  * Aroof      * dT +
        sp.params.Ufloor * Afloor     * dT +
        sp.params.Uwin   * Awin       * dT;

      const ppl_W = (sp.params.people || 0) * 75;
      const ltg_W = (sp.params.ltg_Wm2 || 0)   * sp.area_floor_m2;
      const eqp_W = (sp.params.equip_Wm2 || 0) * sp.area_floor_m2;
      const Qint_SI = ppl_W + ltg_W + eqp_W;

      sumQtrans += Qtrans_SI;
      sumQint   += Qint_SI;
      sumQtot   += Qtrans_SI + Qint_SI;
    }

    elFloor.textContent = `${formatNum(sumFloor * areaFactor)} ${areaLabel}`;
    elWin.textContent   = `${formatNum(sumWin   * areaFactor)} ${areaLabel}`;
    elTotal.textContent = `${formatNum(sumTotal * areaFactor)} ${areaLabel}`;
    elVol.textContent   = `${formatNum(sumVol   * volFactor)} ${volLabel}`;
    elQTrans.textContent= `${formatNum(sumQtrans * powFactor)} ${powLabel}`;
    elQInt.textContent  = `${formatNum(sumQint   * powFactor)} ${powLabel}`;
    elQTot.textContent  = `${formatNum(sumQtot   * powFactor)} ${powLabel}`;
    return; // ✅ terminamos aquí en multi
  }

  // ÚNICO → como lo tenías antes (usa ids[0])
  const sp = spaces.get(ids[0]);
  if (!sp) return;

  
}

// ====== Picking ======
function onPointerDown(e) {
  const r = viewerEl.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(rootGroup.children, true);
  if (!intersects.length) return;

  // Buscar el PRIMER espacio visible (no oculto) entre todos los hits
  let sid = null;
  let pickPoint = null;
  for (const hit of intersects) {
    let obj = hit.object;
    while (obj && !meshToSpace.has(obj.uuid)) obj = obj.parent;
    const cand = obj ? meshToSpace.get(obj.uuid) : null;
    if (!cand) continue;

    const sp = spaces.get(cand);
    if (!sp) continue;

    // Si está oculto o no visible, ignóralo y prueba el siguiente hit
    if (hiddenIds.has(cand) || !sp.mesh.visible) continue;

    sid = cand;
    pickPoint = hit.point ? hit.point.clone() : null;
    break; // ¡válido!
  }

  if (!sid) return;

  // --- Selección ---
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;

  if (shift && typeof selectRangeBetween === 'function' && lastAnchorId) {
    // Selección por rango (Shift): entre ancla y actual
    selectRangeBetween(lastAnchorId, sid, { additive: ctrl });
  } else if (ctrl) {
    // Toggle individual (Ctrl/Cmd)
    if (selectedIds.has(sid)) selectedIds.delete(sid);
    else selectedIds.add(sid);
    lastAnchorId = sid;
  } else {
    // Selección única
    selectedIds.clear();
    selectedIds.add(sid);
    lastAnchorId = sid;
    // Abre panel en selección única como antes
    expandPanel();
  }

  // Sincroniza UI
  syncDropdownFromSelection();
  onSelectionChanged();
  // Popover flotante junto al clic
  if (selectedIds.size === 1 && pickPoint) {
    showPopover(sid, pickPoint);
  } else {
    hidePopover();
  }
  // Apply DT visuals when no selection
  if (selectedIds.size === 0) { applyAlarmColorsIfNoSelection(); }
  updateSelectionSummaryUI();
}


// ====== Cámara ======
function frameAll() {
  const box = new THREE.Box3().setFromObject(rootGroup);
  if (box.isEmpty()) return;
  frameBox(box);
}
function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  frameBox(box);
}
function frameBox(box) {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);

  rootGroup.position.sub(center);
  edgesGroup.position.copy(rootGroup.position);
  windowsGroup.position.copy(rootGroup.position);

  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = Math.max(1, maxDim * 1.8 / Math.tan((camera.fov * Math.PI) / 360));
  const dir = new THREE.Vector3(1, 0.6, 1).normalize();
  camera.position.copy(new THREE.Vector3().add(dir.multiplyScalar(dist)));
  controls.target.set(0, 0, 0);
  controls.update();
}

// ====== Parser / Geometría ======

function getByLocalName(root, lname) {
  const out = [];
  const all = root.getElementsByTagName('*');
  const target = lname.toLowerCase();
  for (const el of all) {
    const nm = (el.localName || el.tagName || '').toLowerCase();
    if (nm === target) out.push(el);
  }
  return out;
}

function getTextByLocalName(root, lname) {
  const els = getByLocalName(root, lname);
  return els[0]?.textContent?.trim() || '';
}

function getSpacePolyLoops(spaceEl) {
  const shells = getByLocalName(spaceEl, 'ClosedShell');
  const polys = [];
  for (const sh of shells) polys.push(...getByLocalName(sh, 'PolyLoop'));
  return polys;
}

function extractPolyPoints(poly) {
  const cps = getByLocalName(poly, 'CartesianPoint');
  const ptsA = [];
  for (const cp of cps) {
    const cs = getByLocalName(cp, 'Coordinate');
    if (cs.length >= 3) {
      const x = toNum(cs[0].textContent);
      const y = toNum(cs[1].textContent);
      const z = toNum(cs[2].textContent);
      if ([x, y, z].every(Number.isFinite)) ptsA.push(new THREE.Vector3(x, y, z));
    }
  }
  if (ptsA.length >= 3) return ptsA;

  const coords = getByLocalName(poly, 'Coordinate');
  const ptsB = [];
  for (let i = 0; i + 2 < coords.length; i += 3) {
    const x = toNum(coords[i].textContent), y = toNum(coords[i + 1].textContent), z = toNum(coords[i + 2].textContent);
    if ([x, y, z].every(Number.isFinite)) ptsB.push(new THREE.Vector3(x, y, z));
  }
  if (ptsB.length >= 3) return ptsB;

  const xs = getByLocalName(poly, 'X'), ys = getByLocalName(poly, 'Y'), zs = getByLocalName(poly, 'Z');
  const n = Math.min(xs.length, ys.length, zs.length);
  const ptsC = [];
  for (let i = 0; i < n; i++) {
    const x = toNum(xs[i].textContent), y = toNum(ys[i].textContent), z = toNum(zs[i].textContent);
    if ([x, y, z].every(Number.isFinite)) ptsC.push(new THREE.Vector3(x, y, z));
  }
  if (ptsC.length >= 3) return ptsC;

  const nums = (poly.textContent || '').match(/[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
  const ptsD = [];
  if (nums && nums.length >= 9) {
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const x = toNum(nums[i]), y = toNum(nums[i + 1]), z = toNum(nums[i + 2]);
      if ([x, y, z].every(Number.isFinite)) ptsD.push(new THREE.Vector3(x, y, z));
    }
  }
  return ptsD;
}

function toNum(s) { return parseFloat(String(s || '').trim().replace(',', '.')); }

// Devuelve triangulación + info por cara (area, normalZ, centroidZ) para derivar tipos
function triangulateClosedShellWithFaceInfo(polyloops) {
  const positions = [];
  let triCount = 0;

  let globalMinZ = Number.POSITIVE_INFINITY;
  let globalMaxZ = Number.NEGATIVE_INFINITY;

  const facesInfo = []; // { area, normalZ, centroidZ }

  for (const poly of polyloops) {
    const pts3 = extractPolyPoints(poly);
    if (pts3.length < 3) continue;

    for (const p of pts3) {
      if (p.z < globalMinZ) globalMinZ = p.z;
      if (p.z > globalMaxZ) globalMaxZ = p.z;
    }

    const tris = triangulateFace(pts3);
    let faceArea = 0;

    for (const tri of tris) {
      positions.push(tri[0].x, tri[0].y, tri[0].z);
      positions.push(tri[1].x, tri[1].y, tri[1].z);
      positions.push(tri[2].x, tri[2].y, tri[2].z);
      faceArea += triangleArea(tri[0], tri[1], tri[2]);
      triCount++;
    }

    const n = faceNormal(pts3);
    const centroidZ = pts3.reduce((s,p)=>s+p.z,0) / pts3.length;
    facesInfo.push({ area: faceArea, normalZ: n.z, centroidZ });
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();

  geom.userData.facesInfo = facesInfo;
  geom.userData.globalMinZ = globalMinZ;
  geom.userData.globalMaxZ = globalMaxZ;

  return { geometry: geom, triCount };
}

function deriveAreas(facePack) {
  const faces = facePack.geometry.userData.facesInfo || [];
  const minZ = facePack.geometry.userData.globalMinZ ?? 0;
  const maxZ = facePack.geometry.userData.globalMaxZ ?? 0;

  const height = Math.max(0, maxZ - minZ);
  const tol = Math.max(0.01, 0.02 * height);

  let total = 0, floor = 0, roof = 0, walls = 0;
  for (const f of faces) {
    total += f.area;
    const isHorizontal = Math.abs(f.normalZ) > 0.9;
    const isBottom = (f.centroidZ - minZ) <= tol;
    const isTop    = (maxZ - f.centroidZ) <= tol;

    if (isHorizontal && isBottom) floor += f.area;
    else if (isHorizontal && isTop) roof += f.area;
    else walls += f.area;
  }
  return { total, floor, roof, walls };
}

function triangulateFace(points3) {
  const n = faceNormal(points3);
  const u = new THREE.Vector3();
  if (Math.abs(n.x) > Math.abs(n.y)) u.set(-n.z, 0, n.x).normalize();
  else u.set(0, n.z, -n.y).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();

  const pts2 = points3.map(p => new THREE.Vector2(p.dot(u), p.dot(v)));
  const faces = THREE.ShapeUtils.triangulateShape(pts2, []);
  const tris = [];
  for (const f of faces) tris.push([ points3[f[0]].clone(), points3[f[1]].clone(), points3[f[2]].clone() ]);
  return tris;
}

function faceNormal(points) {
  if (points.length < 3) return new THREE.Vector3(0, 0, 1);
  const o = points[0];
  const n = new THREE.Vector3(0,0,0);
  for (let i = 1; i < points.length - 1; i++) {
    const v1 = points[i].clone().sub(o);
    const v2 = points[i+1].clone().sub(o);
    n.add(new THREE.Vector3().crossVectors(v1, v2));
  }
  return n.normalize();
}

function triangleArea(a, b, c) {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  return new THREE.Vector3().crossVectors(ab, ac).length() * 0.5;
}

function computeMeshVolume(geometry) {
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  let vol = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i+1), by = pos.getY(i+1), bz = pos.getZ(i+1);
    const cx = pos.getX(i+2), cy = pos.getY(i+2), cz = pos.getZ(i+2);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6.0;
  }
  return Math.abs(vol);
}

// ====== Util ======
function colorFromString(str) {
  let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  const rgb = hslToRgb(hue, 0.55, 0.55);
  return (rgb[0] << 16) | (rgb[1] << 8) | (rgb[2]);
}
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n, k = (n + h * 12) % 12) => l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
}
function formatNum(x) {
  return (Math.round(x * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escapeHtml(s) { return (s || '').replace(/[&<>\"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ====== CSV helpers (simple) ======
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // doble comilla escapada
      if (inQ && line[i+1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSwitchBotCsv(text, fallbackName = 'Sensor') {
  const lines = (text || '').split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) throw new Error('CSV vacío o inválido');

  const header = splitCsvLine(lines[0]).map(s => s.trim());
  const idxDate = header.findIndex(h => /^date$/i.test(h));
  const idxTemp = header.findIndex(h => /temp/i.test(h));
  const idxRh   = header.findIndex(h => /humidity/i.test(h));

  if (idxDate === -1 || idxTemp === -1 || idxRh === -1) {
    throw new Error('No encuentro columnas Date/Temperature/Humidity en el CSV');
  }

  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const ds = (cols[idxDate] || '').trim();
    if (!ds) continue;

    // dd/mm/yyyy HH:MM
    const m = ds.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (!m) continue;
    const d = new Date(+m[3], (+m[2]) - 1, +m[1], +m[4], +m[5], 0, 0);

    const temp = parseFloat(String(cols[idxTemp] || '').replace(',', '.'));
    const rh   = parseFloat(String(cols[idxRh] || '').replace(',', '.'));

    if (!Number.isFinite(temp) || !Number.isFinite(rh)) continue;
    data.push({ t: d, temp, rh });
  }

  data.sort((a,b) => a.t - b.t);

  return {
    name: fallbackName,
    data
  };
}

function refreshSensorSelect() {
  if (!selSensorEl) return;
  const prev = selSensorEl.value;
  selSensorEl.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '— (importa un CSV)';
  selSensorEl.appendChild(opt0);

  for (const [id, s] of Object.entries(telemetryState.sensors)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = s.name || id;
    selSensorEl.appendChild(opt);
  }

  if (prev && telemetryState.sensors[prev]) selSensorEl.value = prev;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function drawSpark(svgEl, series, key) {
  if (!svgEl) return;
  svgEl.innerHTML = '';
  if (!series || series.length < 2) return;

  const W = 300, H = 90, pad = 10;
  const xs = series.map(p => p.t.getTime());
  const ys = series.map(p => p[key]);

  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yr = (ymax - ymin) || 1;

  const toX = (t) => pad + ( (t - xmin) / (xmax - xmin || 1) ) * (W - 2*pad);
  const toY = (v) => (H - pad) - ( (v - ymin) / yr ) * (H - 2*pad);

  // grid (2 líneas horizontales)
  const g1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  g1.setAttribute('x1', pad); g1.setAttribute('x2', W-pad);
  g1.setAttribute('y1', toY(ymin + yr*0.33)); g1.setAttribute('y2', toY(ymin + yr*0.33));
  g1.setAttribute('stroke', '#28305e'); g1.setAttribute('stroke-width', '1');
  svgEl.appendChild(g1);

  const g2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  g2.setAttribute('x1', pad); g2.setAttribute('x2', W-pad);
  g2.setAttribute('y1', toY(ymin + yr*0.66)); g2.setAttribute('y2', toY(ymin + yr*0.66));
  g2.setAttribute('stroke', '#28305e'); g2.setAttribute('stroke-width', '1');
  svgEl.appendChild(g2);

  // polyline
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  const pts = series.map(p => `${toX(p.t.getTime()).toFixed(2)},${toY(p[key]).toFixed(2)}`).join(' ');
  pl.setAttribute('points', pts);
  pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', '#d3a93e');
  pl.setAttribute('stroke-width', '2');
  pl.setAttribute('stroke-linejoin', 'round');
  pl.setAttribute('stroke-linecap', 'round');
  svgEl.appendChild(pl);

  // min/max labels
  const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t1.setAttribute('x', pad); t1.setAttribute('y', pad + 10);
  t1.setAttribute('fill', '#a9b0c0'); t1.setAttribute('font-size', '10');
  t1.textContent = `${ymax.toFixed(1)}`;
  svgEl.appendChild(t1);

  const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t2.setAttribute('x', pad); t2.setAttribute('y', H - pad);
  t2.setAttribute('fill', '#a9b0c0'); t2.setAttribute('font-size', '10');
  t2.textContent = `${ymin.toFixed(1)}`;
  svgEl.appendChild(t2);
}


function getRangeFilteredForPopover(data){
  if (!data || !data.length) return [];
  if (popoverChartRange === 'all') return data;

  const now = data[data.length - 1].t.getTime(); // ancla al último dato disponible
  const ms =
    popoverChartRange === '2h'  ? 2 * 3600 * 1000 :
    popoverChartRange === '24h' ? 24 * 3600 * 1000 :
    popoverChartRange === '7d'  ? 7 * 24 * 3600 * 1000 :
    null;

  if (!ms) return data;
  const cut = now - ms;
  return data.filter(p => p.t.getTime() >= cut);
}

function getRangeFiltered(data) {
  const range = selRangeEl?.value || 'all';
  if (!data || !data.length) return [];
  if (range === 'all') return data;

  const now = data[data.length - 1].t.getTime();
  const ms = (range === '24h') ? 24*3600*1000 : 7*24*3600*1000;
  const cut = now - ms;
  return data.filter(p => p.t.getTime() >= cut);
}

function renderTelemetryForSelection() {
  if (!telemetrySummaryEl) return;

  if (selectedIds.size !== 1) {
    telemetrySummaryEl.textContent = 'Selecciona 1 espacio para ver sus datos.';
    if (svgTempEl) svgTempEl.innerHTML = '';
    if (svgRhEl) svgRhEl.innerHTML = '';
    return;
  }

  const spaceId = [...selectedIds][0];
  const sp = spaces.get(spaceId);
  const sensorId = telemetryState.spaceToSensor[spaceId];

  if (!sensorId || !telemetryState.sensors[sensorId]) {
    const label = sp?.name ? `${sp.name}` : spaceId;
    telemetrySummaryEl.textContent = `Sin sensor asignado a “${label}”. Elige un sensor y pulsa “Asignar a espacio”.`;
    if (svgTempEl) svgTempEl.innerHTML = '';
    if (svgRhEl) svgRhEl.innerHTML = '';
    return;
  }

  const s = telemetryState.sensors[sensorId];
  const data = getRangeFiltered(s.data);

  if (!data.length) {
    telemetrySummaryEl.textContent = `Sensor “${s.name}” asignado, pero no hay datos en la ventana seleccionada.`;
    if (svgTempEl) svgTempEl.innerHTML = '';
    if (svgRhEl) svgRhEl.innerHTML = '';
    return;
  }

  const last = data[data.length - 1];
  const temps = data.map(p => p.temp);
  const rhs   = data.map(p => p.rh);

  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const rmin = Math.min(...rhs),   rmax = Math.max(...rhs);

  telemetrySummaryEl.textContent =
    `Espacio: ${sp?.name || spaceId} · Sensor: ${s.name} · Último: ${last.t.toLocaleString()} · ` +
    `${last.temp.toFixed(1)} °C, ${last.rh.toFixed(0)} %HR ` +
    `(T ${tmin.toFixed(1)}–${tmax.toFixed(1)} · HR ${rmin.toFixed(0)}–${rmax.toFixed(0)})`;

  drawSpark(svgTempEl, data, 'temp');
  drawSpark(svgRhEl, data, 'rh');
}



function setInputsFromCurrentSelection() {
  const ids = [...selectedIds];
  if (ids.length === 0) return;

  // usa SIEMPRE el primer id de la selección
  const sp = spaces.get(ids[0]);
  if (!sp) return;

  inDT.value      = sp.params.dT;
  inPeople.value  = sp.params.people;
  inLtg.value     = sp.params.ltg_Wm2;
  inEquip.value   = sp.params.equip_Wm2;

  const spaceTypeEl = document.getElementById('space_type');
  if (spaceTypeEl) spaceTypeEl.value = sp.params.spaceType || 'oficinas';
}
 // === Utils para Guardar/Cargar ===

// Hash SHA-256 del texto (para vincular proyecto <-> gbXML)
async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Descargar blob como archivo
function downloadBlob(content, filename, mimetype = 'application/json') {
  const blob = new Blob([content], { type: mimetype });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}


function exitToOverview() {
  selectedIds.clear();
  // Restaurar color/alpha de todos los espacios
  for (const s of spaces.values()) {
    if (s.mesh && s.mesh.material) {
      s.mesh.material.opacity = 0.5;
      s.mesh.material.color.setHex(s.color);
      s.mesh.material.needsUpdate = true;
    }
  }

  // UI: panel reducido
  document.getElementById('sidePanel').classList.add('collapsed');
  // Aristas visibles según checkbox
  edgesGroup.visible = chkEdgesEl.checked;

  // Mostrar ventana solo si checkbox "Ventanas" está activo
  windowsGroup.visible = document.getElementById('chkWindows').checked;

  // Cámara vuelve a vista general
  //frameAll();

  // Limpiar contenidos pero NO borrar parámetros del espacio
  spaceInfoEl.innerHTML = '<div class="kv"><span>Selecciona un espacio…</span></div>';
  selSpaceEl.value = '';
  elFloor.textContent = elTotal.textContent = elVol.textContent = elWin.textContent = '—';
  // limpiar panel de información (pero NO tocar sp.params)
  spaceInfoEl.innerHTML = '<div class="kv"><span>Selecciona un espacio…</span></div>';

  updateSelectionSummaryUI();
  syncSelectionVisuals();
  syncTiles();
  syncDropdownFromSelection();
  onSelectionChanged(true);
  selSpaceEl.value = '';
  document.getElementById('sidePanel').classList.add('collapsed');
  renderGroupShortcuts(); // <- crea los chips
}

function expandPanel(opts) {
  // Soporta: expandPanel(), expandPanel(true), expandPanel({ keepDropdownOpen: true })
  let keepDropdownOpen = false;
  if (typeof opts === 'boolean') {
    keepDropdownOpen = opts;
  } else if (opts && typeof opts === 'object') {
    keepDropdownOpen = !!opts.keepDropdownOpen;
  }

  const panel = document.getElementById('sidePanel');
  panel.classList.remove('collapsed');

  // Destapar por si quedaron ocultos
  ['spaceInfo', 'areaBlock', 'loadsBlock'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });

  // Cerrar dropdown solo si NO pedimos mantenerlo abierto
  if (!keepDropdownOpen && typeof ddRoot !== 'undefined' && ddRoot) {
    ddRoot.classList.remove('open');
  }
}



function selectSingle(id) {
  selectedIds.clear();
  selectedIds.add(id);
  syncSelectionVisuals();
  highlightSpace(id); // reutilizamos tu lógica de zoom y panel
  syncTiles();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);

  // Si queda exactamente 1 → usa highlightSpace (panel lleno). Si hay 0 → no hace nada especial
  syncSelectionVisuals();
  syncTiles();

  if (selectedIds.size === 1) {
    const only = [...selectedIds][0];
    selSpaceEl.value = only;
    document.getElementById('sidePanel').classList.remove('collapsed');
    highlightSpace(only);
  } else if (selectedIds.size > 1) {
    // Modo multi: panel muestra contador y no pisa valores salvo que el user edite
    selSpaceEl.value = '';
    document.getElementById('sidePanel').classList.remove('collapsed');
    spaceInfoEl.innerHTML = `<div class="kv"><span><b>${selectedIds.size} espacios seleccionados</b></span><span class="pill">Multi</span></div>`;
    // Opcional: podríamos mostrar sumas/medias aquí. Por ahora lo dejamos claro y limpio.
  }
}

function syncSelectionVisuals() {
  // Materiales de malla (como ya hacías)
  for (const s of spaces.values()) {
    const on = selectedIds.size === 0 ? true : selectedIds.has(s.id);
    s.mesh.material.opacity = on ? (selectedIds.size===0 ? 0.35 : 0.85) : 0.15;
    s.mesh.material.color.setHex(on ? (s._dtBaseColor ?? s.color) : 0x888888);
    s.mesh.material.needsUpdate = true;

    // Contornos por espacio (si los añadiste con Box3Helper)
    if (s.boxHelper) {
      if (selectedIds.size === 0) {
        s.boxHelper.material.color.setHex(0x2266cc);
        s.boxHelper.visible = chkEdgesEl.checked;
      } else if (selectedIds.has(s.id)) {
        s.boxHelper.material.color.setHex(0xffffff); // seleccionado
        s.boxHelper.visible = chkEdgesEl.checked;
      } else {
        s.boxHelper.material.color.setHex(0x2266cc);
        s.boxHelper.visible = chkEdgesEl.checked;
      }
    }
  }
}

function syncTiles() {
  const cont = document.getElementById('spaceTiles');
  if (!cont) return;
  cont.querySelectorAll('.tile').forEach(el => {
    const id = el.dataset.spaceId;
    el.classList.toggle('selected', selectedIds.has(id));
  });
}

function onSelectionChanged(fromClear = false, keepDdOpen = false) {
  // Visual 3D (mallas + contornos si los tienes)
  for (const s of spaces.values()) {
    const on = (selectedIds.size === 0) ? true : selectedIds.has(s.id);
    s.mesh.material.opacity = on ? (selectedIds.size===0 ? 0.35 : 0.85) : 0.15;
    s.mesh.material.color.setHex(on ? (s._dtBaseColor ?? s.color) : 0x888888);
    s.mesh.material.needsUpdate = true;

    if (s.boxHelper) {
      if (selectedIds.size === 0) {
        s.boxHelper.material.color.setHex(0x2266cc);
        s.boxHelper.visible = chkEdgesEl.checked;
      } else if (selectedIds.has(s.id)) {
        s.boxHelper.material.color.setHex(0xffffff);
        s.boxHelper.visible = chkEdgesEl.checked;
      } else {
        s.boxHelper.material.color.setHex(0x2266cc);
        s.boxHelper.visible = chkEdgesEl.checked;
      }
    }
  }

  // Panel: si una sola selección → panel completo del espacio
  if (selectedIds.size >= 1) { expandPanel({ keepDropdownOpen: keepDdOpen }); }
  if (selectedIds.size === 1) {
    const only = [...selectedIds][0];
    document.getElementById('sidePanel').classList.remove('collapsed');
    selSpaceEl.value = only; // por compatibilidad con tu código existente
    highlightSpace(only);
  } else if (selectedIds.size > 1) {
     selSpaceEl.value = '';
    spaceInfoEl.innerHTML = `<div class="kv"><span><b>${selectedIds.size} espacios seleccionados</b></span></div>`;
    // NO LLAMAR highlightSpace aquí
    setInputsFromCurrentSelection(); // carga inputs del primero de la selección
    updateDerivedOutputs();          // muestra sumatorio
    zoomOutGeneric();                // encuadre general sin “reenfocar” al terreno
    //exitToOverview({ collapse: true });


    return;
  } else {
    // 0 seleccionados
    if (!fromClear) {
      spaceInfoEl.innerHTML = '<div class="kv"><span>Selecciona un espacio…</span></div>';
      elFloor.textContent = elTotal.textContent = elVol.textContent = elWin.textContent = '—';
      elQTrans.textContent = elQInt.textContent = elQTot.textContent = '—';
    }
  }
  // Apply DT visuals when no selection
  if (selectedIds.size === 0) { applyAlarmColorsIfNoSelection(); }
  updateSelectionSummaryUI();
  updateDerivedOutputs();
}



// ====== Ventanas desde <Surface><Opening> ======
function addOpeningsFromXml(xml) {
  // Busca todos los <Opening> (Window, Door, Skylight...)
  const openings = getByLocalName(xml, 'Opening');
  if (!openings.length) return;

  const matWin  = new THREE.MeshStandardMaterial({
    color: 0x66aaff,
    transparent: true,
    opacity: 0.35,
    roughness: 0.2,
    metalness: 0.4,
    side: THREE.DoubleSide
  });
  const matEdge = new THREE.LineBasicMaterial({ color: 0x2266cc });

  let count = 0;

  for (const op of openings) {
    // En algunos gbXML hay más de un PolyLoop por Opening (marcos, etc.)
    const loops = getByLocalName(op, 'PolyLoop');
    for (const loop of loops) {
      const pts3 = extractPolyPoints(loop);
      if (pts3.length < 3) continue;

      // Triangulamos igual que hacemos con las caras de Space
      const tris = triangulateFace(pts3);
      const positions = [];
      for (const t of tris) {
        positions.push(
          t[0].x, t[0].y, t[0].z,
          t[1].x, t[1].y, t[1].z,
          t[2].x, t[2].y, t[2].z
        );
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.computeVertexNormals();

      const mesh = new THREE.Mesh(geom, matWin.clone());
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), matEdge);
      windowsGroup.add(mesh);
      windowsGroup.add(edges);
      count++;
    }
  }

  console.info(`[DBG] Ventanas dibujadas (panels): ${count}`);
}

// ====== Áreas de ventanas por espacio (desde <Surface><Opening>) ======
function accumulateWindowAreasPerSpace(xml) {
  // surfaceType que consideraremos "exteriores" para ventanas
  const exteriorTypes = new Set(['ExteriorWall', 'Roof', 'RoofCeiling', 'UndergroundWall']); // ajustable

  const surfaces = getByLocalName(xml, 'Surface');
  let windowsCount = 0, areaSum = 0;

  for (const surf of surfaces) {
    const sType = (surf.getAttribute('surfaceType') || '').trim();
    const openings = getByLocalName(surf, 'Opening');
    if (!openings.length) continue;

    // Adjacent spaces
    const adjEls = getByLocalName(surf, 'AdjacentSpaceId');
    const adjIds = adjEls
      .map(e => e.getAttribute('spaceIdRef') || e.textContent || '')
      .map(s => s.trim())
      .filter(Boolean);

    // Si hay 2 adyacentes, probablemente es interior: ignoramos para cargas hacia exterior
    const isExterior = exteriorTypes.has(sType) || adjIds.length <= 1;
    if (!isExterior) continue;

    for (const op of openings) {
      const oType = (op.getAttribute('openingType') || '').toLowerCase();
      if (oType && !/window|skylight/.test(oType)) continue; // solo ventanas/claraboyas

      const loops = getByLocalName(op, 'PolyLoop');
      for (const loop of loops) {
        const pts3 = extractPolyPoints(loop);
        if (pts3.length < 3) continue;

        // área del opening = suma de triángulos de su PolyLoop
        const tris = triangulateFace(pts3);
        let a = 0;
        for (const t of tris) a += triangleArea(t[0], t[1], t[2]);

        if (a <= 0) continue;

        // ¿a qué espacio se asigna?
        // - si hay 1 adjacente → a ese
        // - si hay 0 → no sabemos; lo asignamos a ninguno
        const targetIds = adjIds.length === 1 ? adjIds : [];

        for (const sid of targetIds) {
          const sp = spaces.get(sid);
          if (!sp) continue;
          sp.area_window_m2 = (sp.area_window_m2 || 0) + a;
          windowsCount++;
          areaSum += a;
        }
      }
    }
  }

  // Ajustar walls efectivos (walls - windows)
  for (const sp of spaces.values()) {
    const win = sp.area_window_m2 || 0;
    sp.area_walls_eff_m2 = Math.max(0, (sp.area_walls_m2 || 0) - win);
  }

  console.info(`[DBG] Ventanas asociadas a espacios: ${windowsCount}, área total = ${areaSum.toFixed(2)} m²`);
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    zoomOutGeneric();  
    exitToOverview({ collapse:true });
  }
});

function renderGroupShortcuts() {
  const wrap = document.getElementById('groupShortcuts');
  if (!wrap) return;
  wrap.innerHTML = '';

  // Agrupa espacios por tipología
  const byType = new Map();
  for (const sp of spaces.values()) {
    const t = (sp.params.spaceType || 'sin_tipo').toString();
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(sp.id);
  }
  // Crea chips
  for (const [type, ids] of byType.entries()) {
    const chip = document.createElement('div');
    chip.className = 'group-chip';
    chip.textContent = `${type} (${ids.length})`;
    chip.addEventListener('click', () => {
      selectedIds.clear();
      ids.forEach(id => selectedIds.add(id));
      // Abrimos panel y sincronizamos todo
      document.getElementById('sidePanel').classList.remove('collapsed');
      syncDropdownFromSelection();
      onSelectionChanged();
      setInputsFromCurrentSelection();
      ddRoot.classList.remove('open');
    });
    wrap.appendChild(chip);
  }
}

// ===== AUTO-ORBIT =====

//Wait mode 
function startAutoOrbit() {
  if (!controls) return;
  controls.autoRotate = true;
  controls.autoRotateSpeed = AUTO_ORBIT_SPEED;
}

function stopAutoOrbit() {
  if (!controls) return;
  controls.autoRotate = false;
}

function resetIdleTimer() {
  // Cualquier actividad del usuario detiene la auto-rotación y reinicia contador
  stopAutoOrbit();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    startAutoOrbit();
  }, IDLE_DELAY_MS);
}

/// ===== ZOOM HELPERS =====

// BBox de los spaces (si pasas ids → de esos; si no → de todos)
function getSpacesBox(ids = null) {
  const box = new THREE.Box3();
  let has = false;
  for (const sp of spaces.values()) {
    if (ids && !ids.has(sp.id)) continue;
    if (!sp.mesh) continue;
    const b = new THREE.Box3().setFromObject(sp.mesh);
    box.union(b);
    has = true;
  }
  return has ? box : null;
}

// Mueve cámara manteniendo dirección actual respecto al target
function tweenCameraToBox(box, duration = 900, margin = 1.6) {
  if (!box) return;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const fov = camera.fov * Math.PI / 180;
  const maxDim = Math.max(size.x, size.y, size.z);
  const fitDist = (maxDim * margin) / (2 * Math.tan(fov / 2));

  // Mantener dirección actual de la cámara
  const dir = camera.position.clone().sub(controls.target).normalize();
  const newPos = center.clone().add(dir.multiplyScalar(fitDist));

  new TWEEN.Tween(camera.position)
    .to({ x: newPos.x, y: newPos.y, z: newPos.z }, duration)
    .easing(TWEEN.Easing.Cubic.Out)
    .start();

  new TWEEN.Tween(controls.target)
    .to({ x: center.x, y: center.y, z: center.z }, duration)
    .easing(TWEEN.Easing.Cubic.Out)
    .start();
}

// ===== ZOOM ANIMATIONS =====

// Zoom-in al espacio seleccionado (usa dirección actual)
function zoomToMesh(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  tweenCameraToBox(box, 900, 1.6);
}

// Zoom-out genérico: multiselección → seleccionados; si no, todos los spaces
function zoomOutGeneric() {
  const ids = selectedIds.size > 1 ? selectedIds : null;
  const box = ids ? getSpacesBox(ids) : getSpacesBox(); // solo Spaces, ignora terreno
  // Un poco más de margen para overview
  tweenCameraToBox(box, 900, 1.0);
}

// === Guardar proyecto (función reutilizable) ===
async function guardar() {
  return new Promise(resolve => {
    const snap = buildProjectSnapshot();
    const json = JSON.stringify(snap, null, 2);
    const base = (currentGbxmlInfo.fileName || 'model').replace(/\.[^.]+$/,'');
    downloadBlob(json, `${base}.syngala.json`);

    // Pequeña pausa para dejar que el navegador descargue antes de salir
    setTimeout(resolve, 4000);
  });
}

// === Confirmación antes de ir al inicio ===
const logoLink = document.getElementById("logoLink");

if (logoLink) {
  logoLink.addEventListener("click", async (e) => {
    e.preventDefault();

    const confirmExit = confirm("¿Deseas guardar antes de salir?");

    if (confirmExit) {
      await guardar(); //Guardamos el proyecto
      window.location.href = logoLink.href;
    } else {
      window.location.href = logoLink.href;
    }
  });
}

function buildProjectSnapshot() {
  const unit = unitSelectEl?.value || 'si';
  const showWindows = !!document.getElementById('chkWindows')?.checked;
  const panelCollapsed = document.getElementById('sidePanel')?.classList.contains('collapsed') || false;

  // params por espacio
  const spacesData = {};
  for (const sp of spaces.values()) {
    spacesData[sp.id] = {
      name: sp.name,
      zoneId: sp.zoneId || '',
      params: { ...sp.params } // dT, U*, people, ltg_Wm2, equip_Wm2, spaceType
    };
  }

  // Compactamos series para que el JSON pese menos: [iso, temp, rh]
  const sensorsPacked = {};
  for (const [id, s] of Object.entries(telemetryState.sensors)) {
    sensorsPacked[id] = {
      id,
      name: s.name || id,
      // meta para distinguir CSV vs LIVE al restaurar
      source: s.source || 'csv',
      data: Array.isArray(s.data) ? s.data.map(p => [p.t.toISOString(), p.temp, p.rh]) : []
    };
  }

  return {
    schema: 'syngala-project-v2',
    createdAt: new Date().toISOString(),
    gbxml: {
      fileName: currentGbxmlInfo.fileName || 'model.gbxml',
      embeddedText: lastGbxmlText || ''  // gbXML dentro del proyecto
    },
    ui: { unit, showWindows, panelCollapsed },
    //camera: cam,
    selection: Array.from(selectedIds),
    spaces: spacesData,
    assemblies: projectState.assemblies,
    assignments: projectState.assignments,
    telemetry: {
      spaceToSensor: telemetryState.spaceToSensor,
      sensors: sensorsPacked
    },
    // Config LIVE (SYNLIVE) para restaurar checkbox + baseURL
    synlive: {
      enabled: !!chkLiveEl?.checked,
      base: liveBaseEl?.value || ''
    },
    dt: {
      defaults: DT_DEFAULTS,
      dayWindows: DT_DAY_WINDOWS,
      spaceConfig: dtSpaceConfig
    }
  };
}

async function restoreProjectSnapshot(snapshot) {
  if (!snapshot || (snapshot.schema !== 'syngala-project-v1' && snapshot.schema !== 'syngala-project-v2')) {
    throw new Error('Formato o versión incompatible');
  }

  // 1) Si viene gbXML embebido, primero lo cargamos
  if (snapshot.gbxml?.embeddedText) {
    // Carga el modelo antes de aplicar parámetros
    loadGbxml(snapshot.gbxml.embeddedText);
    // Ojo: loadGbxml es síncrono en tu app; si no, espera a un “evento cargado”.
    lastGbxmlText = snapshot.gbxml.embeddedText; // actualiza cache
    currentGbxmlInfo.fileName = snapshot.gbxml.fileName || 'model.gbxml';
  }

  // 2) UI básica
  if (snapshot.ui) {
    if (unitSelectEl && snapshot.ui.unit) {
      unitSelectEl.value = snapshot.ui.unit;
    }
    const chkWin = document.getElementById('chkWindows');
    if (chkWin && typeof snapshot.ui.showWindows === 'boolean') {
      chkWin.checked = snapshot.ui.showWindows;
      windowsGroup.visible = chkWin.checked;
    }
  }

  
  // 4) Parámetros por espacio
  const spacesData = snapshot.spaces || {};
  let applied = 0;
  for (const [id, data] of Object.entries(spacesData)) {
    const sp = spaces.get(id);
    if (!sp) continue;
    if (data.params) {
      // pisamos solo los campos que existan en tu esquema
      sp.params.dT        = Number(data.params.dT ?? sp.params.dT);
      sp.params.Uwall     = Number(data.params.Uwall ?? sp.params.Uwall);
      sp.params.Uroof     = Number(data.params.Uroof ?? sp.params.Uroof);
      sp.params.Ufloor    = Number(data.params.Ufloor ?? sp.params.Ufloor);
      sp.params.Uwin      = Number(data.params.Uwin ?? sp.params.Uwin);
      sp.params.people    = Number.isFinite(+data.params.people) ? Math.max(0, Math.floor(+data.params.people)) : sp.params.people;
      sp.params.ltg_Wm2   = Number(data.params.ltg_Wm2 ?? sp.params.ltg_Wm2);
      sp.params.equip_Wm2 = Number(data.params.equip_Wm2 ?? sp.params.equip_Wm2);
      if (data.params.spaceType) sp.params.spaceType = String(data.params.spaceType);
    }
    applied++;
  }
  console.log(`[RESTORE] Parámetros aplicados en ${applied} espacios`);

  // 5) Selección (opcional)
  selectedIds.clear();
  if (Array.isArray(snapshot.selection)) {
    for (const id of snapshot.selection) if (spaces.has(id)) selectedIds.add(id);
  }

  // 6) Refresco de UI/cálculos
  if (selectedIds.size === 1) {
    const only = [...selectedIds][0];
    selSpaceEl.value = only;
    highlightSpace(only);
  } else if (selectedIds.size > 1) {
    onSelectionChanged(false, true);
  } else {
    updateDerivedOutputs();
  }

  if (snapshot.assemblies) projectState.assemblies = snapshot.assemblies;
  if (snapshot.assignments) projectState.assignments = snapshot.assignments;
  if (snapshot.telemetry) {
    telemetryState.spaceToSensor = snapshot.telemetry.spaceToSensor || {};
    const packed = snapshot.telemetry.sensors || {};
    // v2: trae series embebidas; v1: puede venir solo meta
    telemetryState.sensors = Object.fromEntries(Object.entries(packed).map(([id, s]) => {
      const name = (s && s.name) ? s.name : id;
      const source = (s && s.source) ? String(s.source) : 'csv';
      const data = Array.isArray(s?.data)
        ? s.data.map(row => ({
            t: new Date(row[0]),
            temp: Number(row[1]),
            rh: Number(row[2])
          }))
        : [];
      return [id, { id, name, data, source }];
    }));
    refreshSensorSelect();
  }

  // 7) Config LIVE (SYNLIVE) del proyecto (si existe)
  if (snapshot.synlive) {
    try {
      if (liveBaseEl && typeof snapshot.synlive.base === 'string') liveBaseEl.value = snapshot.synlive.base;
      if (chkLiveEl && typeof snapshot.synlive.enabled === 'boolean') chkLiveEl.checked = snapshot.synlive.enabled;
      // persistimos en localStorage para que el estado sea consistente
      saveLiveCfg?.();
      // reiniciamos live según estado
      if (chkLiveEl?.checked) startLive?.();
      else stopLive?.();
    } catch(e) {}
  }

  // Digital Twin config (per space)
  if (snapshot.dt?.spaceConfig) {
    dtSpaceConfig = snapshot.dt.spaceConfig || {};
    try { localStorage.setItem('dtSpaceConfig', JSON.stringify(dtSpaceConfig)); } catch(e){}
  }

  // Reaplicar colores/markers (si no hay selección)
  applyAlarmColorsIfNoSelection();
  updateSensorSpritesVisibility();

  // refresca selects por si acaso:
  refreshAssemblySelectors?.();
}

function updateSelectionSummaryUI() {
  const n = selectedIds.size;
  if (!selectionSummaryEl || !selectionCountEl) return;

  if (n > 0) {
    selectionSummaryEl.style.display = '';
    selectionCountEl.textContent = String(n);
  } else {
    selectionSummaryEl.style.display = 'none';
    // si ocultamos el resumen, cerramos la lista
    if (selectedListEl) selectedListEl.style.display = 'none';
  }
}

function renderSelectedList() {
  if (!selectedListEl) return;
  if (selectedIds.size === 0) { selectedListEl.style.display = 'none'; return; }

  // Construir pills de los espacios seleccionados
  const frg = document.createDocumentFragment();
  [...selectedIds].forEach(id => {
    const sp = spaces.get(id);
    const label = sp ? `${sp.name || id} (${id})` : id;
    const pill = document.createElement('div');
    pill.className = 'sel-pill';
    pill.dataset.sid = id;
    pill.title = 'Clic para deseleccionar';

    // pill content: “Nombre (ID) ×”
    const text = document.createElement('span');
    text.textContent = label;

    const cross = document.createElement('span');
    cross.className = 'x';
    cross.textContent = '×';

    pill.appendChild(text);
    pill.appendChild(cross);
    frg.appendChild(pill);
  });

  // Vaciar y meter
  selectedListEl.innerHTML = '';
  selectedListEl.appendChild(frg);
}

(function () {
const menu = document.getElementById('menu');
    const toggle = document.getElementById('menuToggle');
    const panel = document.getElementById('menuPanel');

    function setOpen(isOpen) {
      menu.classList.toggle('open', isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
      panel.hidden = !isOpen;
    }

    // Toggle al hacer clic
    toggle.addEventListener('click', () => {
      setOpen(!menu.classList.contains('open'));
    });

    // Cerrar con clic fuera
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) setOpen(false);
    });

    // Cerrar con Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
  })();