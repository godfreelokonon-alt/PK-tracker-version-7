/* ==========================================================================
   TRACKER — The heart of the app
   Fuses GPS + steps + compass, runs 3 modes, computes trust level
   Never freezes the display: if sources disagree, lowers trust but keeps moving
   ========================================================================== */
(() => {
'use strict';

const MAX_WALK_SPEED = 8.33;   // m/s = 30 km/h (piéton max absolu)
const MAX_TRAIN_SPEED = 33.3;  // m/s = 120 km/h

const state = {
  active: false,
  mode: 'libre',               // 'libre' | 'cumulatif' | 'chantier'
  transport: 'walk',           // 'walk' | 'train'
  chantierId: null,
  refTrace: null,              // [{lat, lon, pk_m}, ...]
  pkStart: 0,                  // metres
  pkOffset: 0,                 // applied via recalibration
  pkFin: null,
  currentPKm: 0,
  totalDist: 0,
  lastPos: null,               // { lat, lon, ts, acc }
  lastRawGPS: null,
  lastSpeed: null,
  lastHeading: null,           // degrees (true, post-declination)
  trust: 'go',                 // 'go' | 'slow' | 'stop'
  sens: 1,
  sensLocked: false,
  sensBuf: [],
  kalman: null,
  watchId: null,
  wakeLock: null,
  stride: 0.72,                // default stride length, calibrated
  stepsAtStart: 0,
  stepDist: 0,
  lastStepSync: 0,
  gpsDist: 0,
  sources: { gps: 0, steps: 0 }, // last computed distances per source
  driftEstimate: 0,
  trace: [],                   // current session trace (for ref construction)
  accAlertShown: false,
  lastTrustChange: 0
};

let _onUpdate = null;
let _onEvent = null;

function emit(type, data) { if (_onEvent) _onEvent(type, data); }
function notify() { if (_onUpdate) _onUpdate(getSnapshot()); }

function getSnapshot() {
  const pk = formatPK(state.currentPKm);
  return {
    active: state.active,
    mode: state.mode,
    transport: state.transport,
    pk,
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
    steps: PKT_MOTION.getSteps() - state.stepsAtStart,
    pkFin: state.pkFin
  };
}

function formatPK(pkM) {
  const neg = pkM < 0;
  const abs = Math.abs(pkM);
  const km = Math.floor(abs / 1000);
  const m = Math.round(abs - km * 1000);
  return {
    sign: neg ? '-' : '',
    km: km,
    m: m.toString().padStart(3, '0'),
    full: (neg ? '-' : '') + km + '+' + m.toString().padStart(3, '0')
  };
}

/* ------- DISTANCE SOURCES ------- */

function computeDistanceFromSteps() {
  const steps = PKT_MOTION.getSteps() - state.stepsAtStart;
  return steps * state.stride;
}

function computeGPSDistance(newPos) {
  if (!state.lastRawGPS) return 0;
  return PKT_GEO.haversine(
    state.lastRawGPS.lat, state.lastRawGPS.lon,
    newPos.lat, newPos.lon
  );
}

/* ------- TRUST CALCULATION ------- */

function computeTrust(acc, agreement) {
  // acc: GPS accuracy in metres
  // agreement: relative difference between sources (0..1)
  if (state.mode === 'chantier' && state.refTrace) {
    if (acc < 10) return 'go';
    if (acc < 25) return 'slow';
    return 'stop';
  }
  if (acc < 8 && agreement < 0.15) return 'go';
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

/* ------- GPS HANDLER ------- */

function onGPS(pos) {
  const rawLa = pos.coords.latitude;
  const rawLo = pos.coords.longitude;
  const acc = pos.coords.accuracy;
  const spd = pos.coords.speed;

  // Reject clearly degraded fixes
  if (acc > 60) {
    setTrust('stop');
    emit('gps-weak', { acc });
    notify();
    return;
  }

  // Kalman smoothing
  const filtered = state.kalman.update(rawLa, rawLo, acc);
  const la = filtered.lat;
  const lo = filtered.lon;

  // Append to raw trace (for ref construction, exports)
  state.trace.push({
    lat: +la.toFixed(7),
    lon: +lo.toFixed(7),
    acc: Math.round(acc),
    ts: Date.now(),
    spd: spd
  });
  if (state.trace.length > 100000) state.trace = state.trace.slice(-80000);

  state.lastRawGPS = { lat: la, lon: lo, ts: Date.now() };

  // First fix
  if (!state.lastPos) {
    state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
    setTrust('go');
    notify();
    return;
  }

  const d = PKT_GEO.haversine(state.lastPos.lat, state.lastPos.lon, la, lo);
  const dt = (Date.now() - state.lastPos.ts) / 1000;

  // Adaptive threshold: reject bruit smaller than expected GPS noise
  const threshold = Math.max(1.5, acc * 0.4);
  if (d < threshold) {
    state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
    notify();
    return;
  }

  // Speed plausibility
  const maxSpeed = state.transport === 'train' ? MAX_TRAIN_SPEED : MAX_WALK_SPEED;
  if (dt > 0 && d / dt > maxSpeed) {
    emit('gps-jump', { d, dt });
    return;
  }

  /* --- SENS DETECTION --- */
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
      const proposedSens = (avg < 90 || avg > 270) ? 1 : -1;
      emit('sens-detected', { bearing: avg, sens: proposedSens, label: PKT_GEO.bearingLabel(avg) });
    }
  }

  /* --- COMPUTE PK via active strategy --- */
  if (state.mode === 'chantier' && state.refTrace) {
    // Map-matching: project GPS onto reference polyline
    const proj = PKT_GEO.projectOnPolyline({ lat: la, lon: lo }, state.refTrace);
    if (proj && proj.distance < 40) {
      state.currentPKm = proj.pk_m + state.pkOffset;
      state.totalDist += d;
      state.gpsDist = state.totalDist;
      state.driftEstimate = Math.max(3, proj.distance);
    } else {
      // outside reference — fallback to cumulative
      state.totalDist += d;
      state.gpsDist = state.totalDist;
      state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
      state.driftEstimate += acc * 0.08;
    }
  } else {
    // cumulative mode (libre or cumulatif)
    state.totalDist += d;
    state.gpsDist = state.totalDist;
    state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
    state.driftEstimate += acc * 0.1;
  }

  /* --- FUSE WITH STEP COUNTER if walking --- */
  if (state.transport === 'walk' && PKT_MOTION.permissionGranted) {
    const stepDist = computeDistanceFromSteps();
    state.sources = { gps: state.gpsDist, steps: stepDist };
    const agree = stepDist > 5
      ? Math.abs(stepDist - state.gpsDist) / Math.max(stepDist, state.gpsDist)
      : 0;
    setTrust(computeTrust(acc, agree));
  } else {
    setTrust(computeTrust(acc, 0));
  }

  if (acc > 20 && !state.accAlertShown) {
    state.accAlertShown = true;
    emit('gps-degraded', { acc });
    setTimeout(() => state.accAlertShown = false, 10000);
  }

  state.lastPos = { lat: la, lon: lo, ts: Date.now(), acc };
  state.lastSpeed = spd != null ? Math.round(spd * 3.6) : null;

  notify();
}

function onGPSError(err) {
  setTrust('stop');
  emit('gps-error', { code: err.code, message: err.message });
  notify();
}

/* ------- PUBLIC API ------- */

async function start(opts) {
  opts = opts || {};
  if (state.active) return;

  state.mode = opts.mode || 'libre';
  state.transport = opts.transport || 'walk';
  state.chantierId = opts.chantierId || null;
  state.refTrace = opts.refTrace || null;
  state.pkStart = opts.pkStart || 0;
  state.pkFin = opts.pkFin || null;
  state.pkOffset = 0;
  state.currentPKm = state.pkStart;
  state.totalDist = 0;
  state.gpsDist = 0;
  state.driftEstimate = 0;
  state.lastPos = null;
  state.lastRawGPS = null;
  state.lastSpeed = null;
  state.sens = opts.sens || 1;
  state.sensLocked = opts.sensLocked || false;
  state.sensBuf = [];
  state.kalman = PKT_GEO.Kalman(0.6);
  state.trace = [];
  state.stepsAtStart = PKT_MOTION.getSteps();
  state.stepDist = 0;
  state.stride = opts.stride || 0.72;
  state.active = true;
  state.accAlertShown = false;
  setTrust('slow'); // initial acquisition

  // Request sensor permission (iOS)
  try { await PKT_MOTION.requestPermission(); } catch {}
  PKT_MOTION.start();

  // Wake lock
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}

  // Start GPS
  if (!navigator.geolocation) {
    emit('gps-unavailable');
    state.active = false;
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(onGPS, onGPSError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000
  });

  emit('started', getSnapshot());
  notify();
}

function stop() {
  if (!state.active) return;
  if (state.watchId != null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
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
  const pkM = pkKm * 1000;
  const old = formatPK(state.currentPKm).full;
  state.pkOffset += pkM - state.currentPKm;
  state.currentPKm = pkM;
  state.driftEstimate = 0;
  emit('recalibrated', { from: old, to: formatPK(pkM).full });
  notify();
}

function lockSens(s) {
  state.sens = s;
  state.sensLocked = true;
  // Recompute PK with new sens
  if (state.mode !== 'chantier') {
    state.currentPKm = state.pkStart + state.totalDist * state.sens + state.pkOffset;
  }
  notify();
}

function setStride(s) {
  state.stride = s;
  notify();
}

function getState() { return state; }
function getTrace() { return state.trace.slice(); }
function onUpdate(cb) { _onUpdate = cb; }
function onEvent(cb) { _onEvent = cb; }

window.PKT_TRACKER = {
  start, stop, recalibrate, lockSens, setStride,
  getState, getSnapshot, getTrace,
  onUpdate, onEvent, formatPK
};

})();
