/* ==========================================================================
   MOTION v7 — Brajdic Windowed Peak Detection (UbiComp 2013)
   Corrections vs v6 :
   - Filtre passe-haut corrigé : α = 0.974 (fc = 0.25 Hz @60Hz)
     Formule correcte : y[n] = α·(y[n-1] + x[n] - x[n-1])
   - Utilise event.acceleration (linear, sans gravité) si dispo → iOS le fournit
   - Fenêtre glissante de pics (Windowed Peak Detection) au lieu d'un seuil brut
   - Validation 3 pas consécutifs avant de commencer à compter (anti faux-positifs)
   - Refractory period 300 ms (min humain ~250 ms)
   - Prominence minimum 1.2 m/s² (calibré sur marche lente en tranchée)
   - Magnétomètre désactivé near rail : heading GPS uniquement quand speed > 0.5 m/s
   ========================================================================== */
(() => {
'use strict';

// ---- Constantes calibrées (Brajdic & Harle 2013 + Weinberg AN-602) ----
const HP_ALPHA        = 0.974;   // fc ≈ 0.25 Hz à ~60 Hz — isole la gravité sans toucher la marche
const WINDOW_SAMPLES  = 36;      // fenêtre ~0.6 s à 60 Hz pour détection pic
const SMOOTH_SAMPLES  = 18;      // lissage ~0.3 s
const PROMINENCE_MIN  = 1.2;     // m/s² — prominence minimale pour valider un pic
const REFRACTORY_MS   = 300;     // ms — délai min entre deux pas
const CONFIRM_STEPS   = 3;       // nb de pas consécutifs avant de commencer à compter
const MAX_STEP_MS     = 2000;    // si aucun pas depuis 2 s → réinitialiser la séquence

// ---- État interne ----
let _permissionGranted = false;
let _stepCallback    = null;
let _headingCallback = null;
let _accelListener   = null;
let _orientListener  = null;
let _stepCount       = 0;
let _lastStepTs      = 0;

// Buffer circulaire pour la fenêtre glissante
let _buf      = new Float32Array(WINDOW_SAMPLES);
let _smoothBuf= new Float32Array(SMOOTH_SAMPLES);
let _bufIdx   = 0;
let _smoothIdx= 0;
let _bufFull  = false;
let _smoothFull = false;

// État passe-haut
let _hpPrev   = 0;   // valeur précédente du signal brut
let _hpOut    = 0;   // sortie du filtre HP

// Validation séquence
let _pendingSteps = 0;  // pas détectés non encore confirmés
let _counting     = false; // true après CONFIRM_STEPS

// ---- Passe-haut correct : y[n] = α·(y[n-1] + x[n] - x[n-1]) ----
function highpass(x) {
  _hpOut = HP_ALPHA * (_hpOut + x - _hpPrev);
  _hpPrev = x;
  return _hpOut;
}

// ---- Moyenne glissante (lissage) ----
function smooth(x) {
  _smoothBuf[_smoothIdx % SMOOTH_SAMPLES] = x;
  _smoothIdx++;
  if (_smoothIdx >= SMOOTH_SAMPLES) _smoothFull = true;
  const n = _smoothFull ? SMOOTH_SAMPLES : _smoothIdx;
  let s = 0;
  for (let i = 0; i < n; i++) s += _smoothBuf[i];
  return s / n;
}

// ---- Windowed Peak Detection (Brajdic 2013) ----
// Retourne true si la valeur centrale de la fenêtre est un pic validé
function isPeak() {
  if (!_bufFull) return false;
  const mid = (_bufIdx + Math.floor(WINDOW_SAMPLES / 2)) % WINDOW_SAMPLES;
  const midVal = _buf[mid];

  // Trouver min et max de la fenêtre
  let wMin = Infinity, wMax = -Infinity;
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    if (_buf[i] < wMin) wMin = _buf[i];
    if (_buf[i] > wMax) wMax = _buf[i];
  }

  // Le centre doit être le maximum ET avoir une prominence suffisante
  const prominence = wMax - wMin;
  return (midVal === wMax) && (prominence >= PROMINENCE_MIN);
}

// ---- Handler principal DeviceMotion ----
function _onMotion(e) {
  // Priorité à linear acceleration (sans gravité) si disponible — iOS la fournit
  const lin = e.acceleration;
  const raw = e.accelerationIncludingGravity;
  const dt  = e.interval || 16; // ms

  let mag;
  if (lin && (lin.x !== null) && (Math.abs(lin.x) + Math.abs(lin.y) + Math.abs(lin.z)) > 0.01) {
    // acceleration linéaire disponible → magnitude directe sans gravité
    mag = Math.sqrt((lin.x||0)**2 + (lin.y||0)**2 + (lin.z||0)**2);
  } else if (raw) {
    // fallback : passe-haut sur magnitude brute
    const magRaw = Math.sqrt((raw.x||0)**2 + (raw.y||0)**2 + (raw.z||0)**2);
    mag = Math.abs(highpass(magRaw));
  } else {
    return;
  }

  // Lissage léger puis ajout dans la fenêtre
  const smoothed = smooth(mag);
  _buf[_bufIdx % WINDOW_SAMPLES] = smoothed;
  _bufIdx++;
  if (_bufIdx >= WINDOW_SAMPLES) _bufFull = true;
  _bufIdx = _bufIdx % WINDOW_SAMPLES;

  // Détection pic
  if (!isPeak()) return;

  const now = Date.now();
  if ((now - _lastStepTs) < REFRACTORY_MS) return;

  // Gestion de la séquence de confirmation
  if ((now - _lastStepTs) > MAX_STEP_MS) {
    // Trop long depuis le dernier pas → réinitialiser séquence
    _pendingSteps = 0;
    _counting = false;
  }

  _lastStepTs = now;
  _pendingSteps++;

  if (!_counting) {
    if (_pendingSteps >= CONFIRM_STEPS) {
      // Séquence confirmée : on démarre le comptage
      // et on crédite les CONFIRM_STEPS en retard
      _counting = true;
      _stepCount += CONFIRM_STEPS;
      if (_stepCallback) _stepCallback(_stepCount, now);
    }
    return;
  }

  // Comptage normal
  _stepCount++;
  if (_stepCallback) _stepCallback(_stepCount, now);
}

// ---- Permissions iOS 13+ ----
async function requestPermission() {
  let motionOk = true, orientOk = true;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      motionOk = (await DeviceMotionEvent.requestPermission()) === 'granted';
    }
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      orientOk = (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
  } catch (e) {
    motionOk = false; orientOk = false;
  }
  _permissionGranted = motionOk;  // orientation optionnelle — ne bloque pas
  return _permissionGranted;
}

// ---- Start / Stop ----
function start() {
  if (_accelListener) return;

  // Reset buffers
  _buf       = new Float32Array(WINDOW_SAMPLES);
  _smoothBuf = new Float32Array(SMOOTH_SAMPLES);
  _bufIdx    = 0; _smoothIdx = 0;
  _bufFull   = false; _smoothFull = false;
  _hpPrev    = 0; _hpOut = 0;
  _pendingSteps = 0; _counting = false;

  _accelListener = _onMotion;

  _orientListener = (e) => {
    // Note : en contexte ferroviaire, le magnétomètre est perturbé par les rails.
    // On publie le heading mais tracker.js l'ignorera si GPS speed > 0.5 m/s.
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading; // iOS — déjà corrigé partiellement
    } else if (typeof e.alpha === 'number') {
      heading = (360 - e.alpha) % 360;  // Android
    }
    if (heading !== null && _headingCallback) _headingCallback(heading);
  };

  window.addEventListener('devicemotion',      _accelListener, { passive: true });
  window.addEventListener('deviceorientation', _orientListener, { passive: true });
}

function stop() {
  if (_accelListener) {
    window.removeEventListener('devicemotion',      _accelListener);
    window.removeEventListener('deviceorientation', _orientListener);
    _accelListener  = null;
    _orientListener = null;
  }
}

function onStep(cb)    { _stepCallback    = cb; }
function onHeading(cb) { _headingCallback = cb; }
function resetSteps()  { _stepCount = 0; _lastStepTs = 0; _pendingSteps = 0; _counting = false; }
function getSteps()    { return _stepCount; }
function setSteps(n)   { _stepCount = n; }

// Exposé pour debug terrain : nb de pas en attente de confirmation
function getPendingSteps() { return _pendingSteps; }

window.PKT_MOTION = {
  requestPermission, start, stop,
  onStep, onHeading, resetSteps, getSteps, setSteps, getPendingSteps,
  get permissionGranted() { return _permissionGranted; }
};

})();
