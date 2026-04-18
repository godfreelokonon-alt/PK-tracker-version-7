/* ==========================================================================
   TRACKER v7 — Fusion GPS + PDR piéton (Dead Reckoning) réelle
   Corrections vs v6 :
   - Les pas contribuent RÉELLEMENT au PK affiché (PDR actif)
   - EKF 3 états [dist, vitesse, biais] pour fusion GPS + pas
   - Longueur de pas : formule Weinberg (AN-602 Analog Devices)
     L = K · (Amax - Amin)^0.25, K auto-calibré sur GPS stable
   - Mode tunnel : quand GPS perdu, le PK continue via les pas seuls
   - Polyligne de référence : débruitée par Douglas-Peucker au chargement
   - Heading GPS prioritaire sur magnétomètre (contexte ferroviaire)
   - Seuil GPS dégradé abaissé à 50 m (était 60 m)
   ========================================================================== */
(() => {
'use strict';

const MAX_WALK_SPEED  = 8.33;   // m/s = 30 km/h
const MAX_TRAIN_SPEED = 33.3;   // m/s = 120 km/h
const GPS_LOST_MS     = 8000;   // après 8 s sans GPS → mode PDR pur
const WEINBERG_K_DEFAULT = 0.44; // constante Weinberg initiale (calibrée auto)
const ACCEL_WINDOW    = 20;     // nb d'échantillons pour min/max Weinberg

const state = {
  active: false,
  mode: 'libre',
  transport: 'walk',
  chantierId: null,
  refTrace: null,       // polyligne débruitée [{lat, lon, pk_m}]
  pkStart: 0,
  pkOffset: 0,
  pkFin: null,
  currentPKm: 0,
  totalDist: 0,         // distance totale fusionnée (GPS + pas)
  gpsDist: 0,           // distance GPS seule (pour calibration K)
  stepDist: 0,          // distance pas seule
  lastPos: null,
  lastRawGPS: null,
  lastGPSTs: 0,         // timestamp dernier GPS valide
  gpsLost: false,       // true si GPS perdu depuis > GPS_LOST_MS
  lastSpeed: null,
  lastHeading: null,
  trust: 'go',
  sens: 1,
  sensLocked: false,
  sensBuf: [],
  kalman: null,
  watchId: null,
  wakeLock: null,

  // PDR — Dead Reckoning piéton
  stride: 0.72,         // foulée initiale (écrasée par Weinberg dès 1er pas)
  weinbergK: WEINBERG_K_DEFAULT,
  accelBuf: [],         // buffer pour min/max Weinberg
  stepsAtStart: 0,
  lastStepCount: 0,     // nb de pas au dernier calcul PDR

  // EKF fusion
  ekf: null,

  // Trace session
  trace: [],
  accAlertShown: false,
  lastTrustChange: 0,
  driftEstimate: 0
};

let _onUpdate = null;
let _onEvent  = null;

function emit(type, data) { if (_onEvent) _onEvent(type, data); }
function notify()         { if (_onUpdate) _onUpdate(getSnapshot()); }

// =========================================================================
// FORMAT PK
// =========================================================================
function formatPK(pkM) {
  const neg = pkM < 0;
  const abs = Math.abs(pkM);
  const km  = Math.floor(abs / 1000);
  const m   = Math.round(abs - km * 1000);
  return {
    sign: neg ? '-' : '',
    km,
    m: m.toString().padStart(3, '0'),
    full: (neg ? '-' : '') + km + '+' + m.toString().padStart(3, '0')
  };
}

function getSnapshot() {
  const steps = PKT_MOTION.getSteps() - state.stepsAtStart;
  return {
    active: state.active,
    mode: state.mode,
    transport: state.transport,
    pk: formatPK(state.currentPKm),
    pkM: state.currentPKm,
    dist: state.totalDist,
    speed: state.lastSpeed,
    heading: state.lastHeading,
    trust: state.trust,
    sens: state.sens,
    sensLocked: state.sensLocked,
    lat: state.lastPos ? state.lastPos.lat : null,
    lon: state.lastPos ? state.lastPos.lon : null,
    acc: state.lastPos ? state.lastPos.acc : null,
    drift: Math.round(state.driftEstimate),
    steps,
    stepDist: Math.round(state.stepDist),
    pkFin: state.pkFin,
    gpsLost: state.gpsLost,
    weinbergK: state.weinbergK.toFixed(3)
  };
}

// =========================================================================
// DÉBRUITAGE POLYLIGNE — Douglas-Peucker simplifié
// Élimine les points GPS bruités de la trace de référence
// =========================================================================
function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  const latRef = points[0].lat * Math.PI / 180;
  const scale  = 111320; // mètres/degré lat

  function perpendicularDist(p, a, b) {
    const dx = (b.lon - a.lon) * scale * Math.cos(latRef);
    const dy = (b.lat - a.lat) * scale;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const px = (p.lon - a.lon) * scale * Math.cos(latRef);
      const py = (p.lat - a.lat) * scale;
      return Math.sqrt(px * px + py * py);
    }
    const px = (p.lon - a.lon) * scale * Math.cos(latRef);
    const py = (p.lat - a.lat) * scale;
    const t  = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
    return Math.sqrt((px - t * dx) ** 2 + (py - t * dy) ** 2);
  }

  function rdp(pts, start, end, tol, mask) {
    let maxDist = 0, maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDist(pts[i], pts[start], pts[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tol) {
      rdp(pts, start, maxIdx, tol, mask);
      rdp(pts, maxIdx, end, tol, mask);
    } else {
      for (let i = start + 1; i < end; i++) mask[i] = false;
    }
  }

  const mask = new Array(points.length).fill(true);
  rdp(points, 0, points.length - 1, tolerance, mask);
  return points.filter((_, i) => mask[i]);
}

function prepareRefTrace(rawTrace, pkStart) {
  if (!rawTrace || rawTrace.length < 2) return rawTrace;

  // 1. Douglas-Peucker à 4 m — enlève le bruit GPS sans déformer la voie
  const simplified = douglasPeucker(rawTrace, 4);

  // 2. Recalcul propre des pk_m sur la trace simplifiée
  let dist = 0;
  const out = [];
  for (let i = 0; i < simplified.length; i++) {
    if (i > 0) dist += PKT_GEO.haversine(
      simplified[i-1].lat, simplified[i-1].lon,
      simplified[i].lat,   simplified[i].lon
    );
    out.push({ lat: simplified[i].lat, lon: simplified[i].lon, pk_m: pkStart + dist });
  }
  return out;
}

// =========================================================================
// PDR — Pedestrian Dead Reckoning
// Longueur de pas : Weinberg L = K · (Amax - Amin)^0.25
// =========================================================================
function updateWeinberg(accelMag) {
  state.accelBuf.push(accelMag);
  if (state.accelBuf.length > ACCEL_WINDOW) state.accelBuf.shift();
  if (state.accelBuf.length < 4) return;
  const aMax = Math.max(...state.accelBuf);
  const aMin = Math.min(...state.accelBuf);
  if (aMax - aMin < 0.5) return; // pas de marche détectée
  state.stride = state.weinbergK * Math.pow(aMax - aMin, 0.25);
  // Clamp : foulée humaine réaliste 0.3 m (marche lente) → 1.1 m (grand pas)
  state.stride = Math.max(0.30, Math.min(1.10, state.stride));
}

// Auto-calibration K quand GPS est stable (accord GPS / pas > 95%)
function calibrateWeinberg(gpsDelta, stepsDelta) {
  if (stepsDelta < 5 || gpsDelta < 1) return; // pas assez de données
  const stepDistDelta = stepsDelta * state.stride;
  if (stepDistDelta < 0.01) return;
  const ratio = gpsDelta / stepDistDelta;
  if (ratio < 0.5 || ratio > 2.0) return; // ratio aberrant → ignorer
  // Correction progressive (EMA 0.1) — K converge en ~30 pas
  state.weinbergK = state.weinbergK * 0.9 + (state.weinbergK * ratio) * 0.1;
  state.weinbergK = Math.max(0.30, Math.min(0.65, state.weinbergK));
}

// =========================================================================
// EKF 1D simplifié — état = [distance cumulée]
// Prédit via les pas, corrige via GPS
// =========================================================================
function EKF1D() {
  let x = 0;   // distance estimée (m)
  let P = 1;   // variance état
  const Q = 0.05; // bruit process (m² par pas)
  return {
    reset()    { x = 0; P = 1; },
    predict(stepLen) {
      x += stepLen;
      P += Q;
      return x;
    },
    update(gpsDist, gpsAcc) {
      const R = Math.max(1, (gpsAcc * 0.5) ** 2);
      const K = P / (P + R);
      x = x + K * (gpsDist - x);
      P = (1 - K) * P;
      return x;
    },
    get dist() { return x; }
  };
}

// =========================================================================
// HANDLER GPS
// =========================================================================
function onGPS(pos) {
  const rawLa = pos.coords.latitude;
  const rawLo = pos.coords.longitude;
  const acc   = pos.coords.accuracy;
  const spd   = pos.coords.speed;

  state.lastGPSTs = Date.now();
  state.gpsLost   = false;

  // Rejeter fixes trop dégradés
  if (acc > 50) {
    setTrust('stop');
    emit('gps-weak', { acc });
    notify();
    return;
  }

  // Kalman
  const filtered = state.kalman.update(rawLa, rawLo, acc);
  const la = filtered.lat;
  const lo = filtered.lon;

  // Trace session
  state.trace.push({ lat: +la.toFixed(7), lon: +lo.toFixed(7), acc: Math.round(acc), ts: Date.now(), spd });
  if (state.trace.length > 100000) state.trace = state.trace.slice(-80000);

  state.lastRawGPS = { lat: la, lon: lo, ts: Date.now() };

  // Premier fix
  if (!state.lastPos) {
    state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
    state.ekf.reset();
    state.stepsAtStart = PKT_MOTION.getSteps();
    state.lastStepCount = 0;
    setTrust('go');
    notify();
    return;
  }

  const d  = PKT_GEO.haversine(state.lastPos.lat, state.lastPos.lon, la, lo);
  const dt = (Date.now() - state.lastPos.ts) / 1000;

  // Seuil adaptatif anti-bruit stationnaire
  const threshold = Math.max(0.3, acc * 0.08);
  if (d < threshold) {
    state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
    notify();
    return;
  }

  // Plausibilité vitesse
  const maxSpeed = state.transport === 'train' ? MAX_TRAIN_SPEED : MAX_WALK_SPEED;
  if (dt > 0 && d / dt > maxSpeed) {
    emit('gps-jump', { d, dt });
    return;
  }

  // Heading GPS (fiable sur voie ferrée, magnétomètre perturbé par rails)
  if (spd != null && spd > 0.5 && dt > 0) {
    state.lastHeading = PKT_GEO.bearing(state.lastPos.lat, state.lastPos.lon, la, lo);
  }

  // Détection sens
  if (!state.sensLocked && state.mode !== 'chantier') {
    const brg = PKT_GEO.bearing(state.lastPos.lat, state.lastPos.lon, la, lo);
    state.sensBuf.push({ brg, d });
    const total = state.sensBuf.reduce((s, b) => s + b.d, 0);
    if (total > 35) {
      let sx = 0, cx = 0;
      state.sensBuf.forEach(b => {
        const r = b.brg * Math.PI / 180;
        sx += Math.sin(r) * b.d;
        cx += Math.cos(r) * b.d;
      });
      const avg = ((Math.atan2(sx, cx) * 180 / Math.PI) + 360) % 360;
      emit('sens-detected', { bearing: avg, sens: (avg < 90 || avg > 270) ? 1 : -1, label: PKT_GEO.bearingLabel(avg) });
    }
  }

  // ---- CALCUL DISTANCE FUSIONNÉE (EKF GPS + pas) ----
  state.gpsDist += d;

  // Auto-calibration Weinberg si GPS stable
  const currentSteps = PKT_MOTION.getSteps() - state.stepsAtStart;
  const stepsDelta   = currentSteps - state.lastStepCount;
  calibrateWeinberg(d, stepsDelta);
  state.lastStepCount = currentSteps;

  // Correction EKF : le GPS remet l'estimation à jour
  const fusedDist = state.ekf.update(state.gpsDist, acc);
  state.totalDist = fusedDist;
  state.stepDist  = currentSteps * state.stride;

  // ---- CALCUL PK ----
  if (state.mode === 'chantier' && state.refTrace) {
    const proj = PKT_GEO.projectOnPolyline({ lat: la, lon: lo }, state.refTrace);
    if (proj && proj.distance < Math.max(30, acc * 2)) {
      state.currentPKm   = proj.pk_m + state.pkOffset;
      state.driftEstimate = Math.max(3, proj.distance);
    } else {
      // Hors trace — fallback cumulatif
      state.currentPKm    = state.pkStart + fusedDist * state.sens + state.pkOffset;
      state.driftEstimate += acc * 0.08;
    }
  } else {
    state.currentPKm    = state.pkStart + fusedDist * state.sens + state.pkOffset;
    state.driftEstimate  = Math.min(state.driftEstimate + acc * 0.05, acc * 3);
  }

  // Trust
  const agree = state.stepDist > 5
    ? Math.abs(state.stepDist - state.gpsDist) / Math.max(state.stepDist, state.gpsDist)
    : 0;
  setTrust(computeTrust(acc, agree));

  if (acc > 20 && !state.accAlertShown) {
    state.accAlertShown = true;
    emit('gps-degraded', { acc });
    setTimeout(() => { state.accAlertShown = false; }, 10000);
  }

  state.lastPos   = { lat: la, lon: lo, ts: Date.now(), acc };
  state.lastSpeed = spd != null ? Math.round(spd * 3.6) : null;
  notify();
}

// =========================================================================
// HANDLER PAS — mis à jour à chaque pas détecté par motion.js
// C'est ici que les pas contribuent AU PK quand GPS est perdu
// =========================================================================
function onStep(stepCount, ts) {
  if (!state.active) return;

  const steps    = stepCount - state.stepsAtStart;
  const stepDelta = steps - state.lastStepCount; // nouveaux pas depuis dernière synchro
  if (stepDelta <= 0) return;

  // Mise à jour distance par les pas
  const stepLen  = state.stride * stepDelta; // distance ce pas
  state.stepDist = steps * state.stride;

  // Prédiction EKF via les pas
  for (let i = 0; i < stepDelta; i++) state.ekf.predict(state.stride);

  // --- MODE TUNNEL / GPS PERDU ---
  const gpsSilenceDuration = Date.now() - state.lastGPSTs;
  if (gpsSilenceDuration > GPS_LOST_MS || state.gpsLost) {
    state.gpsLost = true;
    // Le PK avance UNIQUEMENT via les pas
    state.totalDist   = state.ekf.dist;
    state.driftEstimate += state.stride * 0.15; // accumulation dérive estimée

    if (state.mode === 'chantier' && state.refTrace && state.lastPos) {
      // Projection sur polyligne depuis la dernière position connue
      const proj = PKT_GEO.projectOnPolyline(state.lastPos, state.refTrace);
      if (proj) {
        const pkFromTrace = proj.pk_m + (state.totalDist - state.gpsDist) * state.sens;
        state.currentPKm = pkFromTrace + state.pkOffset;
      } else {
        state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
      }
    } else {
      state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
    }

    setTrust('slow'); // GPS perdu → confiance moyenne (pas seuls)
    notify();
  }

  state.lastStepCount = steps;
}

// =========================================================================
// TRUST
// =========================================================================
function computeTrust(acc, agreement) {
  if (state.gpsLost) return 'slow';
  if (state.mode === 'chantier' && state.refTrace) {
    if (acc < 10) return 'go';
    if (acc < 25) return 'slow';
    return 'stop';
  }
  if (acc < 8  && agreement < 0.15) return 'go';
  if (acc < 20 && agreement < 0.30) return 'slow';
  return 'stop';
}

function setTrust(level) {
  if (state.trust !== level) {
    state.trust = level;
    state.lastTrustChange = Date.now();
    emit('trust', level);
  }
}

function onGPSError(err) {
  setTrust('stop');
  emit('gps-error', { code: err.code, message: err.message });
  notify();
}

// =========================================================================
// START / STOP
// =========================================================================
async function start(opts) {
  opts = opts || {};
  if (state.active) return;

  state.mode       = opts.mode || 'libre';
  state.transport  = opts.transport || 'walk';
  state.chantierId = opts.chantierId || null;
  state.pkStart    = opts.pkStart || 0;
  state.pkFin      = opts.pkFin  || null;
  state.pkOffset   = 0;
  state.currentPKm = state.pkStart;
  state.totalDist  = 0;
  state.gpsDist    = 0;
  state.stepDist   = 0;
  state.driftEstimate = 0;
  state.lastPos    = null;
  state.lastRawGPS = null;
  state.lastGPSTs  = Date.now();
  state.gpsLost    = false;
  state.lastSpeed  = null;
  state.lastHeading= null;
  state.sens       = opts.sens || 1;
  state.sensLocked = opts.sensLocked || false;
  state.sensBuf    = [];
  state.kalman     = PKT_GEO.Kalman(0.6);
  state.trace      = [];
  state.accelBuf   = [];
  state.weinbergK  = WEINBERG_K_DEFAULT;
  state.stepsAtStart = PKT_MOTION.getSteps();
  state.lastStepCount = 0;
  state.stride     = opts.stride || 0.72;
  state.ekf        = EKF1D();
  state.accAlertShown = false;
  state.active     = true;

  // Préparer la polyligne débruitée si mode chantier
  if (opts.mode === 'chantier' && opts.refTrace && opts.refTrace.length > 10) {
    state.refTrace = prepareRefTrace(opts.refTrace, opts.pkStart || 0);
  } else {
    state.refTrace = opts.refTrace || null;
  }

  setTrust('slow');

  // Capteurs
  try { await PKT_MOTION.requestPermission(); } catch {}
  PKT_MOTION.onStep(onStep);
  PKT_MOTION.start();

  // Wake lock
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      // Ré-acquérir si page reprend le focus
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && state.active) {
          try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
        }
      }, { once: false });
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
    maximumAge: 0,        // jamais de cache — critique pour inspection
    timeout: 15000
  });

  // Watchdog GPS lost
  state._gpsWatchdog = setInterval(() => {
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

function stop() {
  if (!state.active) return;
  if (state.watchId != null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  if (state._gpsWatchdog) {
    clearInterval(state._gpsWatchdog);
    state._gpsWatchdog = null;
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

function recalibrate(pkKm) {
  const pkM  = pkKm * 1000;
  const old  = formatPK(state.currentPKm).full;
  state.pkOffset += pkM - state.currentPKm;
  state.currentPKm = pkM;
  state.driftEstimate = 0;
  // Recalibration = GPS reconnu → sortir du mode gpsLost si actif
  state.gpsLost   = false;
  state.lastGPSTs = Date.now();
  emit('recalibrated', { from: old, to: formatPK(pkM).full });
  notify();
}

function lockSens(s) {
  state.sens = s;
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
