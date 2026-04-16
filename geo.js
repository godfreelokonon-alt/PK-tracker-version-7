/* ==========================================================================
   GEO — haversine, bearing, polyline projection (map-matching core)
   ========================================================================== */
(() => {
'use strict';

const EARTH_R = 6371000;
const DEG2RAD = Math.PI / 180;

function toRad(d) { return d * DEG2RAD; }

function haversine(la1, lo1, la2, lo2) {
  const dLa = toRad(la2 - la1);
  const dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa/2)**2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo/2)**2;
  return EARTH_R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing(la1, lo1, la2, lo2) {
  const dLo = toRad(lo2 - lo1);
  const y = Math.sin(dLo) * Math.cos(toRad(la2));
  const x = Math.cos(toRad(la1)) * Math.sin(toRad(la2))
          - Math.sin(toRad(la1)) * Math.cos(toRad(la2)) * Math.cos(dLo);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Magnetic declination France is ~2°E (2025); we approximate by region
// Paris region ~+1.5°, France average ~+1° to +2°
function magneticToTrueBearing(magBearing, lat, lon) {
  // Simple approximation for metropolitan France
  if (lat > 41 && lat < 52 && lon > -5 && lon < 10) {
    return (magBearing + 1.5 + 360) % 360;
  }
  return magBearing;
}

function bearingLabel(deg) {
  const labels = ['Nord', 'Nord-Est', 'Est', 'Sud-Est', 'Sud', 'Sud-Ouest', 'Ouest', 'Nord-Ouest'];
  return labels[Math.round(deg / 45) % 8];
}

/* -------- POLYLINE PROJECTION (map-matching to reference trace) --------
   Given a point (lat, lon) and a polyline [{lat, lon, pk_m}, ...]
   Returns the closest point on the polyline and its PK value.
   This is the heart of the "map-matching" approach.
---------------------------------------------------------------------- */

function projectOnSegment(pt, a, b) {
  // Project lat/lon onto segment a->b using equirectangular approximation
  // (accurate enough for short segments < 1km)
  const latRef = toRad((a.lat + b.lat) / 2);
  const ax = 0, ay = 0;
  const bx = (b.lon - a.lon) * DEG2RAD * EARTH_R * Math.cos(latRef);
  const by = (b.lat - a.lat) * DEG2RAD * EARTH_R;
  const px = (pt.lon - a.lon) * DEG2RAD * EARTH_R * Math.cos(latRef);
  const py = (pt.lat - a.lat) * DEG2RAD * EARTH_R;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLen2 = abx*abx + aby*aby;
  if (abLen2 === 0) {
    return { lat: a.lat, lon: a.lon, t: 0, distance: Math.sqrt(px*px + py*py) };
  }
  let t = (apx*abx + apy*aby) / abLen2;
  t = Math.max(0, Math.min(1, t));
  const projLat = a.lat + t * (b.lat - a.lat);
  const projLon = a.lon + t * (b.lon - a.lon);
  const dx = px - t * abx;
  const dy = py - t * aby;
  return { lat: projLat, lon: projLon, t, distance: Math.sqrt(dx*dx + dy*dy) };
}

function projectOnPolyline(pt, poly) {
  if (!poly || poly.length < 2) return null;
  let best = { distance: Infinity };
  for (let i = 0; i < poly.length - 1; i++) {
    const seg = projectOnSegment(pt, poly[i], poly[i+1]);
    if (seg.distance < best.distance) {
      best = {
        ...seg,
        segmentIdx: i,
        pk_m: poly[i].pk_m + seg.t * (poly[i+1].pk_m - poly[i].pk_m)
      };
    }
  }
  return best;
}

/* -------- KALMAN 1D for GPS smoothing --------
   Simple scalar Kalman filter per axis, using accuracy as measurement variance.
---------------------------------------------------------------------- */

function Kalman(processNoise = 0.5) {
  let lat = null, lon = null, P = 100;
  const Q = processNoise;
  return {
    reset() { lat = null; lon = null; P = 100; },
    update(measLat, measLon, accuracy) {
      if (lat === null) {
        lat = measLat; lon = measLon;
        P = accuracy * accuracy;
        return { lat, lon, variance: P };
      }
      const R = Math.max(1, accuracy * accuracy);
      const Pp = P + Q;
      const K = Pp / (Pp + R);
      lat = lat + K * (measLat - lat);
      lon = lon + K * (measLon - lon);
      P = (1 - K) * Pp;
      return { lat, lon, variance: P };
    },
    get state() { return { lat, lon, variance: P }; }
  };
}

window.PKT_GEO = {
  EARTH_R, haversine, bearing,
  magneticToTrueBearing, bearingLabel,
  projectOnPolyline, projectOnSegment,
  Kalman
};

})();
