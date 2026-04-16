/* ==========================================================================
   PHOTO — camera access, timestamp stamping, IndexedDB storage
   Handles iOS Safari quirks (requires user gesture, facingMode environment)
   ========================================================================== */
(() => {
'use strict';

let _stream = null;

async function openCamera(videoEl) {
  closeCamera();
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    videoEl.srcObject = _stream;
    await videoEl.play();
    return true;
  } catch (err) {
    console.warn('Camera error:', err);
    return false;
  }
}

function closeCamera() {
  if (_stream) {
    _stream.getTracks().forEach(t => t.stop());
    _stream = null;
  }
}

function captureFromVideo(videoEl, stampInfo, quality = 0.82) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  const MAX = 1600;
  let w = vw, h = vh;
  if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, w, h);

  // Stamp overlay at bottom
  stampCanvas(ctx, w, h, stampInfo);

  return canvas.toDataURL('image/jpeg', quality);
}

function captureFromImage(img, stampInfo, quality = 0.85) {
  const MAX = 1600;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  stampCanvas(ctx, w, h, stampInfo);
  return canvas.toDataURL('image/jpeg', quality);
}

function stampCanvas(ctx, w, h, info) {
  const pk = info.pk || '—';
  const chantier = info.chantier || '';
  const coords = info.lat ? info.lat.toFixed(5) + '°N ' + info.lon.toFixed(5) + '°E' : '';
  const dt = info.ts ? new Date(info.ts).toLocaleString('fr-FR') : new Date().toLocaleString('fr-FR');

  const fs = Math.max(14, Math.round(w / 50));
  ctx.font = '500 ' + fs + 'px ui-monospace, "SF Mono", Menlo, monospace';

  const lineH = fs + 7;
  const lines = [
    'PK ' + pk + (chantier ? '  ·  ' + chantier : ''),
    dt + (coords ? '  ·  ' + coords : '')
  ].filter(Boolean);

  const pad = 10;
  const boxH = lines.length * lineH + pad * 2;
  ctx.fillStyle = 'rgba(10,14,26,0.78)';
  ctx.fillRect(0, h - boxH, w, boxH);
  ctx.fillStyle = '#F5F7FA';
  lines.forEach((l, i) => ctx.fillText(l, pad, h - boxH + pad + fs + i * lineH));
}

async function savePhoto(dataUrl) {
  const id = 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await PKT_DB.put(PKT_DB.STORES.photos, dataUrl, id);
  return id;
}

async function loadPhoto(id) {
  return await PKT_DB.get(PKT_DB.STORES.photos, id);
}

window.PKT_PHOTO = {
  openCamera, closeCamera,
  captureFromVideo, captureFromImage,
  savePhoto, loadPhoto
};

})();
