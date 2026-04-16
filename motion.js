/* ==========================================================================
   MOTION — Step detection from accelerometer + compass from device orientation
   Handles iOS permission quirks and magnetometer calibration drift
   ========================================================================== */
(() => {
'use strict';

let _permissionGranted = false;
let _stepCallback = null;
let _headingCallback = null;
let _accelListener = null;
let _orientListener = null;
let _stepCount = 0;
let _lastStepTs = 0;
let _gravSmoothed = 9.81;
let _highpass = 0;

// Peak detection for walking pattern: high-pass filter + threshold
const STEP_THRESHOLD = 1.1; // m/s² after filter
const MIN_STEP_INTERVAL_MS = 270; // fastest realistic step

async function requestPermission() {
  // iOS 13+ requires explicit permission gesture
  let motionOk = true, orientOk = true;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      motionOk = r === 'granted';
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      orientOk = r === 'granted';
    }
  } catch (e) {
    motionOk = false; orientOk = false;
  }
  _permissionGranted = motionOk && orientOk;
  return _permissionGranted;
}

function start() {
  if (_accelListener) return; // already started

  _accelListener = (e) => {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a) return;
    const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
    _gravSmoothed = _gravSmoothed * 0.9 + mag * 0.1;
    const filtered = mag - _gravSmoothed;
    _highpass = _highpass * 0.7 + (filtered - _highpass) * 0.3;

    const now = Date.now();
    if (_highpass > STEP_THRESHOLD && (now - _lastStepTs) > MIN_STEP_INTERVAL_MS) {
      _stepCount++;
      _lastStepTs = now;
      if (_stepCallback) _stepCallback(_stepCount, now);
    }
  };

  _orientListener = (e) => {
    // webkitCompassHeading is iOS-specific and already compensates magnetic→true (partial)
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading;
    } else if (typeof e.alpha === 'number') {
      // Android: alpha is counter-clockwise from east; convert to clockwise from north
      heading = (360 - e.alpha) % 360;
    }
    if (heading !== null && _headingCallback) {
      _headingCallback(heading);
    }
  };

  window.addEventListener('devicemotion', _accelListener, { passive: true });
  window.addEventListener('deviceorientation', _orientListener, { passive: true });
}

function stop() {
  if (_accelListener) {
    window.removeEventListener('devicemotion', _accelListener);
    _accelListener = null;
  }
  if (_orientListener) {
    window.removeEventListener('deviceorientation', _orientListener);
    _orientListener = null;
  }
}

function onStep(cb) { _stepCallback = cb; }
function onHeading(cb) { _headingCallback = cb; }
function resetSteps() { _stepCount = 0; _lastStepTs = 0; }
function getSteps() { return _stepCount; }
function setSteps(n) { _stepCount = n; }

window.PKT_MOTION = {
  requestPermission, start, stop,
  onStep, onHeading, resetSteps, getSteps, setSteps,
  get permissionGranted() { return _permissionGranted; }
};

})();
