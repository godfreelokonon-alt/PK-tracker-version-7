/* ==========================================================================
   TRACKER v7.1 — Simple, direct, fiable
   Principe :
   - GPS = source principale du PK (direct, sans EKF)
   - Pas = backup uniquement quand GPS perdu > 6 secondes
   - Kalman 1D sur position GPS (lissage position, pas distance)
   - Seuil anti-bruit minimal pour ne pas bloquer le PK
   ========================================================================== */
(() => {
'use strict';

const MAX_WALK_SPEED  = 8.33;   // m/s = 30 km/h
const MAX_TRAIN_SPEED = 33.3;   // m/s = 120 km/h
const GPS_LOST_MS     = 6000;   // 6s sans GPS → bascule sur pas

const state = {
  active:       false,
  mode:         'libre',       // 'libre' | 'cumulatif' | 'chantier'
  transport:    'walk',
  chantierId:   null,
  refTrace:     null,
  pkStart:      0,
  pkOffset:     0,
  pkFin:        null,

  currentPKm:   0,
  totalDist:    0,             // distance cumulée GPS (mètres)
  stepDist:     0,             // distance cumulée pas (mètres)

  lastPos:      null,          // { lat, lon, ts, acc }
  lastGPSTs:    0,
  gpsLost:      false,

  lastSpeed:    null,
  lastHeading:  null,
  trust:        'go',
  sens:         1,
  sensLocked:   false,
  sensBuf:      [],

  kalman:       null,
  watchId:      null,
  wakeLock:     null,
  _watchdog:    null,

  stride:       0.72,
  stepsAtStart: 0,
  lastStepCount: 0,

  trace:        [],
  driftEstimate: 0,
  accAlertShown: false,
  lastTrustChange: 0
};

let _onUpdate = null;
let _onEvent  = null;

function emit(type, data) { if (_onEvent) _onEvent(type, data); }
function notify()         { if (_onUpdate) _onUpdate(getSnapshot()); }

// =========================================================================
// FORMAT PK  ex: 42+350
// =========================================================================
function formatPK(pkM) {
  const neg = pkM < 0;
  const abs = Math.abs(pkM);
  const km  = Math.floor(abs / 1000);
  const m   = Math.round(abs - km * 1000);
  return {
    sign: neg ? '-' : '',
    km,
    m:    m.toString().padStart(3, '0'),
    full: (neg ? '-' : '') + km + '+' + m.toString().padStart(3, '0')
  };
}

function getSnapshot() {
  const steps = Math.max(0, PKT_MOTION.getSteps() - state.stepsAtStart);
  const dist  = state.gpsLost ? state.stepDist : state.totalDist;
  return {
    active:      state.active,
    mode:        state.mode,
    transport:   state.transport,
    pk:          formatPK(state.currentPKm),
    pkM:         state.currentPKm,
    dist,                                        // distance affichée
    distGPS:     state.totalDist,                // distance GPS brute
    distSteps:   state.stepDist,                 // distance pas brute
    speed:       state.lastSpeed,
    heading:     state.lastHeading,
    trust:       state.trust,
    sens:        state.sens,
    sensLocked:  state.sensLocked,
    lat:         state.lastPos?.lat  ?? null,
    lon:         state.lastPos?.lon  ?? null,
    acc:         state.lastPos?.acc  ?? null,
    drift:       Math.round(state.driftEstimate),
    steps,
    pkFin:       state.pkFin,
    gpsLost:     state.gpsLost
  };
}

// =========================================================================
// TRUST
// =========================================================================
function computeTrust(acc) {
  if (state.gpsLost)                              return 'slow';
  if (state.mode === 'chantier' && state.refTrace) {
    if (acc < 10) return 'go';
    if (acc < 25) return 'slow';
    return 'stop';
  }
  if (acc < 8)  return 'go';
  if (acc < 25) return 'slow';
  return 'stop';
}

function setTrust(level) {
  if (state.trust !== level) {
    state.trust = level;
    state.lastTrustChange = Date.now();
    emit('trust', level);
  }
}

// =========================================================================
// DÉBRUITAGE POLYLIGNE (Douglas-Peucker 4 m)
// =========================================================================
function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts;
  const latRef = pts[0].lat * Math.PI / 180;
  const sc = 111320;

  function dist(p, a, b) {
    const dx = (b.lon - a.lon) * sc * Math.cos(latRef);
    const dy = (b.lat - a.lat) * sc;
    const len2 = dx*dx + dy*dy;
    const px = (p.lon - a.lon) * sc * Math.cos(latRef);
    const py = (p.lat - a.lat) * sc;
    if (len2 === 0) return Math.sqrt(px*px + py*py);
    const t = Math.max(0, Math.min(1, (px*dx + py*dy) / len2));
    return Math.sqrt((px - t*dx)**2 + (py - t*dy)**2);
  }

  function rdp(s, e, mask) {
    let maxD = 0, idx = s;
    for (let i = s+1; i < e; i++) {
      const d = dist(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { rdp(s, idx, mask); rdp(idx, e, mask); }
    else for (let i = s+1; i < e; i++) mask[i] = false;
  }

  const mask = new Array(pts.length).fill(true);
  rdp(0, pts.length-1, mask);
  return pts.filter((_, i) => mask[i]);
}

function prepareRefTrace(raw, pkStart) {
  if (!raw || raw.length < 2) return raw;
  const simplified = douglasPeucker(raw, 4);
  let dist = 0;
  return simplified.map((p, i) => {
    if (i > 0) dist += PKT_GEO.haversine(simplified[i-1].lat, simplified[i-1].lon, p.lat, p.lon);
    return { lat: p.lat, lon: p.lon, pk_m: pkStart + dist };
  });
}

// =========================================================================
// HANDLER GPS — source principale du PK
// =========================================================================
function onGPS(pos) {
  const rawLa = pos.coords.latitude;
  const rawLo = pos.coords.longitude;
  const acc   = pos.coords.accuracy;
  const spd   = pos.coords.speed;

  state.lastGPSTs = Date.now();

  // Rejeter fixes très dégradés
  if (acc > 80) {
    setTrust('stop');
    emit('gps-weak', { acc });
    notify();
    return;
  }

  // Reprendre après GPS perdu
  if (state.gpsLost) {
    state.gpsLost = false;
    emit('gps-recovered');
  }

  // Filtre Kalman position
  const filtered = state.kalman.update(rawLa, rawLo, acc);
  const la = filtered.lat;
  const lo = filtered.lon;

  // Trace session
  state.trace.push({ lat: +la.toFixed(7), lon: +lo.toFixed(7), acc: Math.round(acc), ts: Date.now(), spd });
  if (state.trace.length > 100000) state.trace = state.trace.slice(-80000);

  // Premier fix
  if (!state.lastPos) {
    state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
    setTrust(computeTrust(acc));
    notify();
    return;
  }

  const d  = PKT_GEO.haversine(state.lastPos.lat, state.lastPos.lon, la, lo);
  const dt = (Date.now() - state.lastPos.ts) / 1000;

  // Seuil anti-bruit minimal — ne bloquer QUE le bruit GPS pur (<30cm)
  if (d < 0.3) {
    state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
    notify();
    return;
  }

  // Plausibilité vitesse
  const maxSpd = state.transport === 'train' ? MAX_TRAIN_SPEED : MAX_WALK_SPEED;
  if (dt > 0 && d / dt > maxSpd) {
    emit('gps-jump', { d, dt });
    return;
  }

  // Heading GPS (fiable sur voie — magnétomètre perturbé par rails)
  if (spd != null && spd > 0.5) {
    state.lastHeading = PKT_GEO.bearing(state.lastPos.lat, state.lastPos.lon, la, lo);
  }

  // Détection sens de marche
  if (!state.sensLocked && state.mode !== 'chantier') {
    const brg = PKT_GEO.bearing(state.lastPos.lat, state.lastPos.lon, la, lo);
    state.sensBuf.push({ brg, d });
    const total = state.sensBuf.reduce((s, b) => s + b.d, 0);
    if (total > 30) {
      let sx = 0, cx = 0;
      state.sensBuf.forEach(b => {
        const r = b.brg * Math.PI / 180;
        sx += Math.sin(r) * b.d;
        cx += Math.cos(r) * b.d;
      });
      const avg = ((Math.atan2(sx, cx) * 180 / Math.PI) + 360) % 360;
      emit('sens-detected', {
        bearing: avg,
        sens:  (avg < 90 || avg > 270) ? 1 : -1,
        label: PKT_GEO.bearingLabel(avg)
      });
    }
  }

  // ---- CALCUL DISTANCE GPS ----
  state.totalDist += d;
  state.driftEstimate = acc;

  // ---- CALCUL PK ----
  if (state.mode === 'chantier' && state.refTrace) {
    const proj = PKT_GEO.projectOnPolyline({ lat: la, lon: lo }, state.refTrace);
    if (proj && proj.distance < Math.max(30, acc * 2)) {
      state.currentPKm   = proj.pk_m + state.pkOffset;
      state.driftEstimate = Math.max(3, proj.distance);
    } else {
      // Hors trace → cumulatif
      state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
    }
  } else {
    // Mode libre ou cumulatif
    state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
  }

  setTrust(computeTrust(acc));

  if (acc > 25 && !state.accAlertShown) {
    state.accAlertShown = true;
    emit('gps-degraded', { acc });
    setTimeout(() => { state.accAlertShown = false; }, 10000);
  }

  state.lastPos   = { lat: la, lon: lo, ts: Date.now(), acc };
  state.lastSpeed = spd != null ? Math.round(spd * 3.6) : null;
  notify();
}

function onGPSError(err) {
  setTrust('stop');
  emit('gps-error', { code: err.code, message: err.message });
  notify();
}

// =========================================================================
// HANDLER PAS — backup quand GPS perdu uniquement
// Appelé depuis ui.js via PKT_MOTION.onStep(cb)
// =========================================================================
function onStepPDR(stepCount, ts) {
  if (!state.active) return;

  const steps      = stepCount - state.stepsAtStart;
  const stepsDelta = steps - state.lastStepCount;
  if (stepsDelta <= 0) return;

  state.stepDist = steps * state.stride;
  state.lastStepCount = steps;

  // N'utiliser les pas pour le PK QUE si GPS perdu
  if (!state.gpsLost) return;

  // PDR pur : le PK avance par les pas
  const distDelta     = stepsDelta * state.stride;
  state.totalDist    += distDelta;
  state.driftEstimate += distDelta * 0.15;

  if (state.mode === 'chantier' && state.refTrace && state.lastPos) {
    const proj = PKT_GEO.projectOnPolyline(state.lastPos, state.refTrace);
    if (proj) {
      state.currentPKm = proj.pk_m + (state.totalDist - state.gpsDist || 0) * state.sens + state.pkOffset;
    } else {
      state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
    }
  } else {
    state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
  }

  notify();
}

// =========================================================================
// START
// =========================================================================
async function start(opts) {
  opts = opts || {};
  if (state.active) return;

  state.mode        = opts.mode || 'libre';
  state.transport   = opts.transport || 'walk';
  state.chantierId  = opts.chantierId || null;
  state.pkStart     = opts.pkStart || 0;
  state.pkFin       = opts.pkFin   || null;
  state.pkOffset    = 0;
  state.currentPKm  = state.pkStart;
  state.totalDist   = 0;
  state.stepDist    = 0;
  state.driftEstimate = 0;
  state.lastPos     = null;
  state.lastGPSTs   = Date.now();
  state.gpsLost     = false;
  state.lastSpeed   = null;
  state.lastHeading = null;
  state.sens        = opts.sens || 1;
  state.sensLocked  = opts.sensLocked || false;
  state.sensBuf     = [];
  state.kalman      = PKT_GEO.Kalman(0.6);
  state.trace       = [];
  state.stepsAtStart = PKT_MOTION.getSteps();
  state.lastStepCount = 0;
  state.stride      = opts.stride || 0.72;
  state.accAlertShown = false;
  state.active      = true;

  // Préparer polyligne débruitée
  if (opts.mode === 'chantier' && opts.refTrace && opts.refTrace.length > 10) {
    state.refTrace = prepareRefTrace(opts.refTrace, opts.pkStart || 0);
  } else {
    state.refTrace = opts.refTrace || null;
  }

  setTrust('slow');

  // Capteurs
  try { await PKT_MOTION.requestPermission(); } catch {}
  PKT_MOTION.start();
  // Enregistrer le handler PDR (backup GPS perdu)
  PKT_MOTION.onStep(onStepPDR);

  // Wake lock + ré-acquisition au retour au premier plan
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && state.active) {
          try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
        }
      });
    }
  } catch {}

  // GPS
  if (!navigator.geolocation) {
    emit('gps-unavailable');
    state.active = false;
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(onGPS, onGPSError, {
    enableHighAccuracy: true,
    maximumAge: 1000,   // accepte un fix de moins d'1s — évite les délais
    timeout: 15000
  });

  // Watchdog GPS lost
  state._watchdog = setInterval(() => {
    if (!state.active) return;
    if (Date.now() - state.lastGPSTs > GPS_LOST_MS && !state.gpsLost) {
      state.gpsLost = true;
      emit('gps-lost');
      setTrust('slow');
      notify();
    }
  }, 2000);

  emit('started', getSnapshot());
  notify();
}

// =========================================================================
// STOP
// =========================================================================
function stop() {
  if (!state.active) return;
  if (state.watchId != null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  if (state._watchdog) {
    clearInterval(state._watchdog);
    state._watchdog = null;
  }
  if (state.wakeLock) {
    try { state.wakeLock.release(); } catch {}
    state.wakeLock = null;
  }
  PKT_MOTION.stop();
  state.active = false;
  setTrust('go');
  emit('stopped', getSnapshot());
  notify();
}

// =========================================================================
// RECALIBRATION
// =========================================================================
function recalibrate(pkKm) {
  const pkM  = pkKm * 1000;
  const old  = formatPK(state.currentPKm).full;
  state.pkOffset   += pkM - state.currentPKm;
  state.currentPKm  = pkM;
  state.driftEstimate = 0;
  state.gpsLost    = false;
  state.lastGPSTs  = Date.now();
  emit('recalibrated', { from: old, to: formatPK(pkM).full });
  notify();
}

function lockSens(s) {
  state.sens       = s;
  state.sensLocked = true;
  if (state.mode !== 'chantier') {
    state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
  }
  notify();
}

function setStride(s) {
  state.stride = Math.max(0.30, Math.min(1.10, s));
  notify();
}

function getState()   { return state; }
function getTrace()   { return state.trace.slice(); }
function onUpdate(cb) { _onUpdate = cb; }
function onEvent(cb)  { _onEvent  = cb; }

window.PKT_TRACKER = {
  start, stop, recalibrate, lockSens, setStride,
  getState, getSnapshot, getTrace,
  onUpdate, onEvent, formatPK
};

})();
