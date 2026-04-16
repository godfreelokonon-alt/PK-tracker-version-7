/* ==========================================================================
   UI CONTROLLER — routing, hub, chantier management, signalement capture
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };

// ------ STATE ------
const app = {
  currentPage: 'hub',
  chantierCourant: null,
  sessionActive: false,
  currentSignalementDraft: null,
  toastTimer: null,
  camStream: null,
  photoCat: ''
};

// ------ TOAST ------
function toast(msg, type = 'info', duration = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  requestAnimationFrame(() => {
    el.classList.add('visible');
  });
  if (app.toastTimer) clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, duration);
}

// ------ SHEET ------
function sheet(opts) {
  return new Promise(resolve => {
    const backdrop = $('sheet-backdrop');
    const s = $('sheet');
    $('sheet-title').textContent = opts.title || '';
    const bodyEl = $('sheet-body');
    if (opts.html) bodyEl.innerHTML = opts.html;
    else bodyEl.textContent = opts.body || '';
    const actionsEl = $('sheet-actions');
    actionsEl.innerHTML = '';
    (opts.actions || [{ label: 'OK', value: true, primary: true }]).forEach(a => {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.className = a.primary ? 'sheet-btn-primary' : a.danger ? 'sheet-btn-danger' : 'sheet-btn-cancel';
      b.onclick = () => {
        s.classList.remove('visible');
        backdrop.classList.remove('visible');
        setTimeout(() => resolve(a.value), 280);
      };
      actionsEl.appendChild(b);
    });
    backdrop.classList.add('visible');
    s.classList.add('visible');
    backdrop.onclick = () => {
      if (opts.dismissible !== false) {
        s.classList.remove('visible');
        backdrop.classList.remove('visible');
        setTimeout(() => resolve(null), 280);
      }
    };
  });
}

// ------ NAVIGATION ------
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = $('page-' + page);
  if (el) el.classList.add('active');
  app.currentPage = page;

  // Update bottom nav
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nav = $('nav-' + page);
  if (nav) nav.classList.add('active');

  // Show/hide navbar depending on page
  const navbar = $('navbar');
  if (page === 'hub' || page === 'journal' || page === 'archive' || page === 'menu') {
    navbar.style.display = 'grid';
  } else {
    navbar.style.display = 'none';
  }

  // Load page data
  if (page === 'hub') renderHub();
  if (page === 'journal') renderJournal();
  if (page === 'archive') renderArchive();
  if (page === 'menu') { updateMenuSessionInfo(); updateQuotaDisplay(); }
}
window.navigate = navigate;

// ------ HUB ------
async function renderHub() {
  const chantiers = await PKT_DB.getAll(PKT_DB.STORES.chantiers);
  chantiers.sort((a,b) => (b.updated||0) - (a.updated||0));
  const list = $('hub-chantier-list');
  if (!chantiers.length) {
    list.innerHTML = '<div class="empty-card">Aucun chantier enregistré. Commencez une marche libre ou créez un chantier.</div>';
    return;
  }
  list.innerHTML = chantiers.slice(0, 6).map(c => {
    const count = c.signalement_count || 0;
    const pkR = c.pk_start != null ? (c.pk_start/1000).toFixed(3) : '—';
    const pkF = c.pk_end != null ? (c.pk_end/1000).toFixed(3) : null;
    const rangeStr = pkF ? `PK ${pkR} → ${pkF}` : `PK ${pkR}`;
    return `
    <div class="chantier-card" onclick="openChantier('${c.id}')">
      <div class="chantier-dot"></div>
      <div class="chantier-body">
        <div class="chantier-name">${esc(c.name)}</div>
        <div class="chantier-meta">${rangeStr} · ${count} point${count>1?'s':''}</div>
      </div>
      <div class="chantier-chevron">›</div>
    </div>`;
  }).join('');
}

// ------ QUICK ACTIONS ------
window.startQuickWalk = async function() {
  await beginSession({ mode: 'libre' });
};

window.startWithPK = async function() {
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">PK de départ (décimal)</label>
      <input id="sheet-pk-input" class="field" type="number" step="0.001" placeholder="ex : 42.350" inputmode="decimal" />
    </div>`;
  const result = await sheet({
    title: 'Démarrer avec PK',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Démarrer', value: 'ok', primary: true }
    ]
  });
  if (result === 'ok') {
    const v = parseFloat($('sheet-pk-input')?.value);
    if (isNaN(v)) { toast('PK invalide', 'error'); return; }
    await beginSession({ mode: 'cumulatif', pkStart: v * 1000 });
  }
};

window.openChantier = async function(id) {
  const c = await PKT_DB.get(PKT_DB.STORES.chantiers, id);
  if (!c) return;
  app.chantierCourant = c;
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Chantier</label>
      <div style="font-size:16px;font-weight:500;margin-bottom:2px;">${esc(c.name)}</div>
      <div style="font-size:13px;color:var(--ink-2);">PK ${(c.pk_start/1000).toFixed(3)}${c.pk_end?' → '+(c.pk_end/1000).toFixed(3):''}</div>
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Mode</label>
      <div style="font-size:13px;color:var(--ink-1);">Localisation précise par map-matching sur le tracé de référence.</div>
    </div>`;
  const result = await sheet({
    title: 'Reprendre le chantier',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Démarrer', value: 'ok', primary: true }
    ]
  });
  if (result === 'ok') {
    await beginSession({
      mode: 'chantier',
      chantierId: c.id,
      refTrace: c.ref_trace,
      pkStart: c.pk_start,
      pkFin: c.pk_end
    });
  }
};

window.createChantier = async function() {
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Nom du chantier</label>
      <input id="sh-name" class="field" type="text" placeholder="ex : RER B — section Aulnay" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Ligne</label>
      <input id="sh-line" class="field" type="text" placeholder="ex : 830000" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">PK de départ</label>
      <input id="sh-pks" class="field" type="number" step="0.001" inputmode="decimal" placeholder="42.000" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">PK de fin (optionnel)</label>
      <input id="sh-pkf" class="field" type="number" step="0.001" inputmode="decimal" placeholder="43.500" />
    </div>
    <div style="font-size:12px;color:var(--ink-2);line-height:1.55;">La première session enregistrera la trace de reconnaissance. Les sessions suivantes utiliseront cette trace pour un repérage précis.</div>`;
  const result = await sheet({
    title: 'Nouveau chantier',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Créer et démarrer', value: 'ok', primary: true }
    ]
  });
  if (result !== 'ok') return;
  const name = $('sh-name').value.trim();
  const line = $('sh-line').value.trim();
  const pks = parseFloat($('sh-pks').value);
  const pkf = parseFloat($('sh-pkf').value);
  if (!name) { toast('Nom requis', 'error'); return; }
  if (isNaN(pks)) { toast('PK de départ requis', 'error'); return; }
  const chantier = {
    id: 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, line: line || null,
    pk_start: pks * 1000,
    pk_end: isNaN(pkf) ? null : pkf * 1000,
    ref_trace: null,
    signalement_count: 0,
    created: Date.now(),
    updated: Date.now()
  };
  await PKT_DB.put(PKT_DB.STORES.chantiers, chantier);
  // Begin reconnaissance session
  await beginSession({
    mode: 'cumulatif',
    chantierId: chantier.id,
    pkStart: chantier.pk_start,
    pkFin: chantier.pk_end,
    isReconnaissance: true
  });
};

// ------ TRACKING SESSION ------
async function beginSession(opts) {
  app.sessionActive = true;
  app.sessionOpts = opts;
  navigate('track');
  $('track-mode').textContent = opts.mode === 'chantier' ? 'CHANTIER' : opts.mode === 'cumulatif' ? 'PK CUMULATIF' : 'MARCHE LIBRE';
  $('btn-main').className = 'btn-main go';
  $('btn-main').innerHTML = iconPlay() + ' Démarrer le suivi';
  $('btn-main').onclick = () => tryStart(opts);
  $('mark-zone').classList.remove('visible');
  refreshTrackingUI(PKT_TRACKER.getSnapshot());
}

async function tryStart(opts) {
  await PKT_TRACKER.start(opts);
  $('btn-main').className = 'btn-main stop';
  $('btn-main').innerHTML = iconStop() + ' Arrêter';
  $('btn-main').onclick = stopSession;
  $('mark-zone').classList.add('visible');
}

async function stopSession() {
  PKT_TRACKER.stop();
  // If reconnaissance, offer to save trace as reference
  if (app.sessionOpts && app.sessionOpts.isReconnaissance && app.sessionOpts.chantierId) {
    const trace = PKT_TRACKER.getTrace();
    if (trace.length > 10) {
      // Build reference with PK interpolation
      const chantier = await PKT_DB.get(PKT_DB.STORES.chantiers, app.sessionOpts.chantierId);
      if (chantier) {
        const refTrace = buildRefTrace(trace, chantier.pk_start);
        chantier.ref_trace = refTrace;
        chantier.updated = Date.now();
        await PKT_DB.put(PKT_DB.STORES.chantiers, chantier);
        toast('Tracé de référence enregistré', 'success');
      }
    }
  }
  $('btn-main').className = 'btn-main go';
  $('btn-main').innerHTML = iconPlay() + ' Démarrer le suivi';
  $('btn-main').onclick = () => tryStart(app.sessionOpts);
  $('mark-zone').classList.remove('visible');
}

function buildRefTrace(trace, pkStart) {
  const out = [];
  let dist = 0;
  for (let i = 0; i < trace.length; i++) {
    const p = trace[i];
    if (i > 0) {
      dist += PKT_GEO.haversine(trace[i-1].lat, trace[i-1].lon, p.lat, p.lon);
    }
    out.push({ lat: p.lat, lon: p.lon, pk_m: pkStart + dist });
  }
  return out;
}

// ------ TRACKING UI ------
function refreshTrackingUI(s) {
  if (!s) s = PKT_TRACKER.getSnapshot();
  const pk = s.pk;
  const pkEl = $('pk-value');
  pkEl.innerHTML = `<span class="pk-km">${pk.sign}${pk.km}</span><span class="pk-plus">+</span><span class="pk-m">${pk.m}</span>`;
  pkEl.classList.toggle('low-trust', s.trust === 'stop');

  // Trust chip
  const chip = $('trust-chip');
  const trustText = {
    go: 'HAUTE CONFIANCE',
    slow: 'CONFIANCE MOYENNE',
    stop: 'À RECALIBRER'
  }[s.trust] || '';
  chip.className = 'trust-chip ' + s.trust;
  chip.innerHTML = '<span class="dot"></span>' + trustText;

  // Subtitle
  const subBits = [];
  if (app.sessionOpts?.isReconnaissance) subBits.push('Reconnaissance');
  else if (s.mode === 'chantier') subBits.push('Map-matching');
  else if (s.mode === 'cumulatif') subBits.push('PK cumulatif');
  else subBits.push('Marche libre');
  if (s.drift > 0 && s.mode !== 'chantier') subBits.push('±' + s.drift + ' m dérive');
  $('pk-sub').innerHTML = subBits.map((b,i) =>
    (i>0 ? '<span class="pk-sub-dot"></span>' : '') + esc(b)
  ).join('');

  // Telemetry
  const dist = s.dist;
  $('telem-dist').textContent = dist < 1000 ? Math.round(dist) + ' m' : (dist/1000).toFixed(2) + ' km';
  $('telem-speed').textContent = s.speed != null ? s.speed : '—';
  $('telem-steps').textContent = s.steps || 0;

  // Progress bar
  if (s.pkFin && app.sessionOpts) {
    const range = Math.abs(s.pkFin - (app.sessionOpts.pkStart || 0));
    if (range > 0) {
      const done = Math.abs(s.pkM - (app.sessionOpts.pkStart || 0));
      const pct = Math.min(100, (done / range) * 100);
      $('pk-bar-wrap').classList.add('visible');
      $('pk-bar-fill').style.width = pct.toFixed(0) + '%';
      $('pk-bar-pct').textContent = pct.toFixed(0) + '%';
    }
  } else {
    $('pk-bar-wrap').classList.remove('visible');
  }
}

// ------ TRACKER EVENTS ------
PKT_TRACKER.onUpdate(refreshTrackingUI);
PKT_TRACKER.onEvent(async (type, data) => {
  if (type === 'sens-detected') {
    const result = await sheet({
      title: 'Confirmer le sens de marche',
      body: `PK croissants vers le ${data.label} (${Math.round(data.bearing)}°). Correct ?`,
      actions: [
        { label: 'Inverser', value: 'no' },
        { label: 'Correct', value: 'yes', primary: true }
      ],
      dismissible: false
    });
    if (result === 'yes') PKT_TRACKER.lockSens(data.sens);
    else PKT_TRACKER.lockSens(-data.sens);
    toast('Sens verrouillé', 'success');
  }
  if (type === 'gps-degraded') {
    toast('GPS dégradé ±' + Math.round(data.acc) + ' m — confiance diminuée', 'warn');
  }
  if (type === 'gps-error') {
    toast('Erreur GPS : ' + data.message, 'error');
  }
  if (type === 'recalibrated') {
    toast('Recalibré : ' + data.from + ' → ' + data.to, 'success');
  }
});

// ------ QUICK MARK ACTIONS ------
window.quickMark = async function(note) {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  await createSignalement({ type: 'normal', note });
  toast(s.pk.full + ' · ' + note, 'success');
  vibrate([80]);
};

window.quickAlert = async function() {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  const note = $('note-input').value.trim() || 'Anomalie';
  await createSignalement({ type: 'alert', note });
  $('note-input').value = '';
  toast('⚠ Alerte au PK ' + s.pk.full, 'error');
  vibrate([140, 60, 140]);
};

window.saveMark = async function() {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  const note = $('note-input').value.trim();
  await createSignalement({ type: 'normal', note });
  $('note-input').value = '';
  toast('PK ' + s.pk.full + ' enregistré', 'success');
  vibrate([80]);
};

window.recalibrate = async function() {
  const v = parseFloat($('recal-input').value);
  if (isNaN(v)) { toast('PK invalide', 'error'); return; }
  PKT_TRACKER.recalibrate(v);
  $('recal-input').value = '';
};

async function createSignalement(opts) {
  const s = PKT_TRACKER.getSnapshot();
  const id = 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date();
  const payload = {
    id,
    chantier_id: app.sessionOpts?.chantierId || null,
    pk: s.pk.full,
    pk_m: Math.round(s.pkM),
    lat: s.lat ? +s.lat.toFixed(7) : null,
    lon: s.lon ? +s.lon.toFixed(7) : null,
    acc: s.acc ? Math.round(s.acc) : null,
    cap: s.heading != null ? Math.round(s.heading) : null,
    trust: s.trust,
    ts: now.toISOString(),
    ts_display: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date_display: now.toLocaleDateString('fr-FR'),
    type: opts.type,
    cat: opts.cat || '',
    note: opts.note || '',
    photo_id: opts.photo_id || null,
    statut: 'ouvert',
    hash: await sha256(id + '|' + Math.round(s.pkM) + '|' + (s.lat||'') + '|' + now.toISOString())
  };
  await PKT_DB.put(PKT_DB.STORES.signalements, payload);
  // Update chantier count
  if (payload.chantier_id) {
    const c = await PKT_DB.get(PKT_DB.STORES.chantiers, payload.chantier_id);
    if (c) { c.signalement_count = (c.signalement_count||0) + 1; c.updated = Date.now(); await PKT_DB.put(PKT_DB.STORES.chantiers, c); }
  }
  return payload;
}

async function sha256(msg) {
  try {
    const buf = new TextEncoder().encode(msg);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
  } catch { return ''; }
}

function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

// ------ JOURNAL ------
let journalFilter = 'all';
async function renderJournal() {
  const all = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  all.sort((a,b) => (b.ts > a.ts ? 1 : -1));
  const list = all.filter(h =>
    journalFilter === 'all'
    || (journalFilter === 'photo' && h.photo_id)
    || (journalFilter === 'alert' && h.type === 'alert')
  );
  $('journal-count').textContent = list.length + ' pt' + (list.length>1?'s':'');
  const el = $('journal-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Aucune entrée</div>';
    return;
  }
  // Render first
  el.innerHTML = list.map(h => `
    <div class="entry${h.type === 'alert' ? ' alert' : ''}">
      <div class="entry-hdr">
        <div>
          <div class="entry-pk">${esc(h.pk)}</div>
          <div class="entry-time">${esc(h.date_display)} · ${esc(h.ts_display)}${h.cat ? ' · ' + esc(h.cat) : ''}</div>
        </div>
        <div class="entry-right">
          <span class="badge ${h.type === 'alert' ? 'alert' : h.photo_id ? 'photo' : 'ok'}">${h.type === 'alert' ? 'Alerte' : h.photo_id ? 'Photo' : 'OK'}</span>
          <button class="del-btn" onclick="delSignalement('${h.id}')">×</button>
        </div>
      </div>
      ${h.photo_id ? `<div class="entry-photo-wrap" data-photo-id="${h.photo_id}"><div style="width:100%;height:140px;background:var(--bg-3);display:flex;align-items:center;justify-content:center;color:var(--ink-3);font-size:11px;">Chargement…</div></div>` : ''}
      <div class="entry-body">
        ${h.note ? '<div class="entry-note">'+esc(h.note)+'</div>' : ''}
        <div class="entry-coords">${h.lat ? h.lat+'°N  '+h.lon+'°E  ±'+h.acc+' m' : ''}${h.cap != null ? '  •  cap '+h.cap+'°' : ''}</div>
      </div>
    </div>
  `).join('');
  // Lazy-load photo thumbs
  document.querySelectorAll('.entry-photo-wrap[data-photo-id]').forEach(async (wrap) => {
    const pid = wrap.dataset.photoId;
    const data = await PKT_DB.get(PKT_DB.STORES.photos, pid);
    if (data) {
      wrap.innerHTML = `<img class="entry-photo" src="${data}" loading="lazy" alt="Photo" />`;
    }
  });
}
window.setFilter = function(f, el) {
  journalFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderJournal();
};
window.delSignalement = async function(id) {
  const ok = await sheet({
    title: 'Supprimer ce point ?',
    body: 'Cette action est irréversible.',
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Supprimer', value: 'yes', danger: true }
    ]
  });
  if (ok === 'yes') {
    await PKT_DB.del(PKT_DB.STORES.signalements, id);
    toast('Supprimé', 'success');
    renderJournal();
  }
};

// ------ PHOTO FLOW ------
let _currentPhotoDataUrl = null;

window.openPhoto = function() {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  navigate('photo');
  refreshPhotoDisplay();
};

window.closePhoto = function() {
  PKT_PHOTO.closeCamera();
  const v = $('cam-video');
  v.srcObject = null; v.style.display = 'none';
  $('cam-ph').style.display = 'block';
  $('btn-cam').style.display = 'flex';
  $('btn-shoot').style.display = 'none';
  $('preview-wrap').style.display = 'none';
  $('photo-note').value = '';
  _currentPhotoDataUrl = null;
  app.photoCat = '';
  document.querySelectorAll('#photo-cats .chip').forEach(c => c.classList.remove('selected'));
  navigate('track');
};

function refreshPhotoDisplay() {
  const s = PKT_TRACKER.getSnapshot();
  $('photo-pk').innerHTML = `<span>${s.pk.sign}${s.pk.km}</span><span class="pk-plus">+</span><span>${s.pk.m}</span>`;
  $('photo-pk-top').textContent = s.pk.full;
  $('photo-coords').textContent = s.lat ? s.lat.toFixed(6)+'°N  '+s.lon.toFixed(6)+'°E  · ±'+s.acc+' m' : '';
}

window.activateCam = async function() {
  const v = $('cam-video');
  const ok = await PKT_PHOTO.openCamera(v);
  if (!ok) { toast('Caméra non disponible', 'error'); return; }
  $('cam-ph').style.display = 'none';
  v.style.display = 'block';
  $('btn-cam').style.display = 'none';
  $('btn-shoot').style.display = 'flex';
  $('preview-wrap').style.display = 'none';
};

window.shoot = function() {
  const v = $('cam-video');
  const s = PKT_TRACKER.getSnapshot();
  const stampInfo = {
    pk: s.pk.full,
    chantier: app.sessionOpts?.chantierId ? (app.chantierCourant?.name || '') : '',
    lat: s.lat, lon: s.lon,
    ts: new Date()
  };
  const dataUrl = PKT_PHOTO.captureFromVideo(v, stampInfo, 0.82);
  if (!dataUrl) { toast('Erreur capture', 'error'); return; }
  PKT_PHOTO.closeCamera();
  v.srcObject = null; v.style.display = 'none';
  _currentPhotoDataUrl = dataUrl;
  $('preview-img').src = dataUrl;
  $('preview-wrap').style.display = 'block';
  $('btn-shoot').style.display = 'none';
  $('btn-cam').style.display = 'flex';
  $('btn-cam').innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l16 16M20 4L4 20"/></svg> Reprendre';
};

window.loadFromGallery = function(evt) {
  const f = evt.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const s = PKT_TRACKER.getSnapshot();
      const stampInfo = {
        pk: s.pk.full,
        chantier: app.chantierCourant?.name || '',
        lat: s.lat, lon: s.lon,
        ts: new Date()
      };
      const dataUrl = PKT_PHOTO.captureFromImage(img, stampInfo, 0.85);
      _currentPhotoDataUrl = dataUrl;
      $('preview-img').src = dataUrl;
      $('preview-wrap').style.display = 'block';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(f);
};

window.setPhotoCat = function(c, el) {
  app.photoCat = c;
  document.querySelectorAll('#photo-cats .chip').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
};

window.savePhotoNormal = async function() {
  if (!_currentPhotoDataUrl) { toast('Prenez une photo d\'abord', 'error'); return; }
  const photoId = await PKT_PHOTO.savePhoto(_currentPhotoDataUrl);
  const note = $('photo-note').value.trim() || app.photoCat;
  await createSignalement({ type: 'photo', note, cat: app.photoCat, photo_id: photoId });
  toast('Photo enregistrée au PK ' + PKT_TRACKER.getSnapshot().pk.full, 'success');
  vibrate([140]);
  closePhoto();
};

window.savePhotoAlert = async function() {
  if (!_currentPhotoDataUrl) { toast('Prenez une photo d\'abord', 'error'); return; }
  const photoId = await PKT_PHOTO.savePhoto(_currentPhotoDataUrl);
  const note = $('photo-note').value.trim() || 'ANOMALIE';
  await createSignalement({ type: 'alert', note, cat: app.photoCat, photo_id: photoId });
  toast('⚠ Alerte photo au PK ' + PKT_TRACKER.getSnapshot().pk.full, 'error');
  vibrate([160, 60, 160]);
  closePhoto();
};

// Update photo display when tracker updates while on photo page
PKT_TRACKER.onUpdate(() => {
  if (app.currentPage === 'photo') refreshPhotoDisplay();
  else refreshTrackingUI();
});

// ------ ARCHIVE ------
let _archiveItems = [];
async function renderArchive() {
  const chantiers = await PKT_DB.getAll(PKT_DB.STORES.chantiers);
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  chantiers.sort((a,b) => (b.updated||0) - (a.updated||0));
  _archiveItems = [];
  chantiers.forEach(c => {
    const chSigs = sigs.filter(s => s.chantier_id === c.id);
    _archiveItems.push({ type: 'chantier', data: c, sigs: chSigs });
  });
  const orphans = sigs.filter(s => !s.chantier_id);
  if (orphans.length) {
    _archiveItems.push({ type: 'orphan', sigs: orphans });
  }
  $('archive-count').textContent = chantiers.length + ' chantier' + (chantiers.length>1?'s':'') + ' · ' + sigs.length + ' pt' + (sigs.length>1?'s':'');
  filterArchive('');
}

function filterArchive(query) {
  const el = $('archive-list');
  const q = (query || '').toLowerCase().trim();
  if (!_archiveItems.length) {
    el.innerHTML = '<div class="empty">Aucun chantier. Créez-en un depuis l\'accueil.</div>';
    return;
  }
  const cards = [];
  for (const item of _archiveItems) {
    if (item.type === 'chantier') {
      const c = item.data;
      const sigs = item.sigs;
      const matches = q
        ? (c.name.toLowerCase().includes(q) || sigs.some(s =>
            (s.pk||'').toLowerCase().includes(q) ||
            (s.note||'').toLowerCase().includes(q) ||
            (s.cat||'').toLowerCase().includes(q)))
        : true;
      if (!matches) continue;
      cards.push(`
        <div class="chantier-card" onclick="openChantierDetail('${c.id}')">
          <div class="chantier-dot" style="background:${c.ref_trace ? 'var(--signal-go)' : 'var(--signal-slow)'};"></div>
          <div class="chantier-body">
            <div class="chantier-name">${esc(c.name)}</div>
            <div class="chantier-meta">PK ${(c.pk_start/1000).toFixed(3)}${c.pk_end?' → '+(c.pk_end/1000).toFixed(3):''} · ${sigs.length} pt${sigs.length>1?'s':''} · ${c.ref_trace?'trace OK':'sans trace'}</div>
          </div>
          <div class="chantier-chevron">›</div>
        </div>
      `);
    } else if (item.type === 'orphan') {
      const matchOrphans = q ? item.sigs.filter(s =>
        (s.pk||'').toLowerCase().includes(q) ||
        (s.note||'').toLowerCase().includes(q) ||
        (s.cat||'').toLowerCase().includes(q)
      ) : item.sigs;
      if (matchOrphans.length) {
        cards.push(`
          <div class="chantier-card" onclick="navigate('journal')">
            <div class="chantier-dot" style="background:var(--ink-3);"></div>
            <div class="chantier-body">
              <div class="chantier-name">Hors chantier</div>
              <div class="chantier-meta">${matchOrphans.length} pt${matchOrphans.length>1?'s':''} · marches libres</div>
            </div>
            <div class="chantier-chevron">›</div>
          </div>
        `);
      }
    }
  }
  el.innerHTML = cards.length ? cards.join('') : '<div class="empty">Aucun résultat</div>';
}

window.searchArchive = function(v) { filterArchive(v); };

window.openChantierDetail = async function(id) {
  const c = await PKT_DB.get(PKT_DB.STORES.chantiers, id);
  if (!c) return;
  const sigs = (await PKT_DB.getAll(PKT_DB.STORES.signalements)).filter(s => s.chantier_id === id);
  const hasTrace = c.ref_trace && c.ref_trace.length > 0;
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Détails</label>
      <div style="font-size:14px;color:var(--ink-1);line-height:1.7;">
        <b style="color:var(--ink-0);">${esc(c.name)}</b><br>
        ${c.line ? 'Ligne ' + esc(c.line) + '<br>' : ''}
        PK ${(c.pk_start/1000).toFixed(3)}${c.pk_end?' → '+(c.pk_end/1000).toFixed(3):''}<br>
        ${sigs.length} signalement${sigs.length>1?'s':''}<br>
        ${hasTrace ? 'Tracé de référence : ' + c.ref_trace.length + ' points' : 'Pas encore de tracé de référence'}
      </div>
    </div>`;
  const result = await sheet({
    title: 'Chantier',
    html,
    actions: [
      { label: 'Supprimer', value: 'delete', danger: true },
      { label: 'Reprendre', value: 'open', primary: true }
    ]
  });
  if (result === 'open') {
    app.chantierCourant = c;
    if (hasTrace) {
      await beginSession({
        mode: 'chantier',
        chantierId: c.id,
        refTrace: c.ref_trace,
        pkStart: c.pk_start,
        pkFin: c.pk_end
      });
    } else {
      await beginSession({
        mode: 'cumulatif',
        chantierId: c.id,
        pkStart: c.pk_start,
        pkFin: c.pk_end,
        isReconnaissance: true
      });
    }
  } else if (result === 'delete') {
    const confirm = await sheet({
      title: 'Supprimer ' + c.name + ' ?',
      body: 'Le chantier et ses ' + sigs.length + ' signalement(s) seront effacés définitivement.',
      actions: [
        { label: 'Annuler', value: null },
        { label: 'Supprimer', value: 'yes', danger: true }
      ]
    });
    if (confirm === 'yes') {
      for (const s of sigs) {
        if (s.photo_id) await PKT_DB.del(PKT_DB.STORES.photos, s.photo_id);
        await PKT_DB.del(PKT_DB.STORES.signalements, s.id);
      }
      await PKT_DB.del(PKT_DB.STORES.chantiers, c.id);
      toast('Chantier supprimé', 'success');
      renderArchive();
    }
  }
};

// ------ EXPORT ------
window.exportKMZ = async function() {
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  if (!sigs.length) { toast('Aucune donnée à exporter', 'error'); return; }
  const chId = app.sessionOpts?.chantierId;
  const chantier = chId ? await PKT_DB.get(PKT_DB.STORES.chantiers, chId) : null;
  const targetSigs = chantier ? sigs.filter(s => s.chantier_id === chId) : sigs;
  const trace = PKT_TRACKER.getTrace();
  try {
    toast('Génération du KMZ…', 'info', 5000);
    const blob = await PKT_EXPORT.exportKMZ(chantier, targetSigs, trace);
    const fname = 'rapport_pk_' + new Date().toISOString().slice(0,10) + '.kmz';
    await PKT_EXPORT.downloadBlob(blob, fname);
    toast('KMZ téléchargé', 'success');
  } catch (e) {
    console.error(e);
    toast('Erreur export : ' + e.message, 'error');
  }
};

window.exportShare = async function() {
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  if (!sigs.length) { toast('Aucune donnée à exporter', 'error'); return; }
  const chId = app.sessionOpts?.chantierId;
  const chantier = chId ? await PKT_DB.get(PKT_DB.STORES.chantiers, chId) : null;
  const targetSigs = chantier ? sigs.filter(s => s.chantier_id === chId) : sigs;
  const trace = PKT_TRACKER.getTrace();
  const data = PKT_EXPORT.buildShareJSON(chantier, targetSigs, trace);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const fname = 'partage_pk_' + new Date().toISOString().slice(0,10) + '.pkt';
  await PKT_EXPORT.downloadBlob(blob, fname);
  toast('Fichier de partage créé', 'success');
};

window.exportPDF = async function() {
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  if (!sigs.length) { toast('Aucune donnée à exporter', 'error'); return; }
  const chId = app.sessionOpts?.chantierId;
  const chantier = chId ? await PKT_DB.get(PKT_DB.STORES.chantiers, chId) : null;
  const targetSigs = chantier ? sigs.filter(s => s.chantier_id === chId) : sigs;
  await openPDFPreview(chantier, targetSigs);
};

async function openPDFPreview(chantier, sigs) {
  const photos = {};
  for (const s of sigs) {
    if (s.photo_id) photos[s.id] = await PKT_DB.get(PKT_DB.STORES.photos, s.photo_id);
  }
  const html = buildPDFHtml(chantier, sigs, photos);
  const w = window.open('', '_blank');
  if (!w) { toast('Débloquez les popups pour imprimer', 'error'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 600);
}

function buildPDFHtml(chantier, sigs, photos) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('fr-FR');
  const alerts = sigs.filter(s => s.type === 'alert');
  const phs = sigs.filter(s => s.photo_id);
  const title = chantier ? chantier.name : 'Rapport de tournée';
  const line = chantier && chantier.line ? 'Ligne ' + chantier.line : '';
  const range = chantier ? 'PK ' + (chantier.pk_start/1000).toFixed(3) + (chantier.pk_end ? ' → ' + (chantier.pk_end/1000).toFixed(3) : '') : '';

  const signalementsHtml = sigs.map((s, i) => {
    const photo = photos[s.id];
    const isAlert = s.type === 'alert';
    return `
      <div class="entry" ${isAlert ? 'data-alert="1"' : ''}>
        <div class="entry-head">
          <div class="entry-num">${String(i+1).padStart(3,'0')}</div>
          <div class="entry-meta">
            <div class="entry-pk">PK ${escPDF(s.pk)}</div>
            <div class="entry-sub">${escPDF(s.date_display)} · ${escPDF(s.ts_display)}${s.cat?' · '+escPDF(s.cat):''}</div>
          </div>
          <div class="entry-type ${isAlert ? 'alert' : s.photo_id ? 'photo' : 'normal'}">${isAlert ? 'ALERTE' : s.photo_id ? 'PHOTO' : 'NORMAL'}</div>
        </div>
        ${photo ? `<div class="entry-img"><img src="${photo}" /></div>` : ''}
        <div class="entry-details">
          ${s.note ? `<div class="entry-note">${escPDF(s.note)}</div>` : ''}
          <table class="entry-table">
            <tr><td>Coordonnées</td><td>${s.lat ? s.lat+'°N  '+s.lon+'°E' : '—'}</td></tr>
            <tr><td>Précision GPS</td><td>${s.acc != null ? '±'+s.acc+' m' : '—'}</td></tr>
            ${s.cap != null ? `<tr><td>Cap</td><td>${s.cap}°</td></tr>` : ''}
            <tr><td>Identifiant</td><td class="mono">${escPDF(s.id)}</td></tr>
            <tr><td>Empreinte</td><td class="mono">${escPDF(s.hash || '—')}</td></tr>
          </table>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escPDF(title)} — Rapport PK</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1f2e; line-height: 1.4; margin: 0; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: -0.01em; }

  .cover { padding: 0 0 20mm; border-bottom: 3px solid #0A0E1A; margin-bottom: 10mm; page-break-after: avoid; }
  .brand { font-family: ui-monospace, monospace; font-size: 10px; letter-spacing: 0.2em; color: #7C8599; text-transform: uppercase; margin-bottom: 6px; }
  .title { font-size: 30px; font-weight: 500; letter-spacing: -0.02em; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #4A5268; margin-bottom: 18px; }

  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; }
  .kpi { border: 1px solid #E5E8EE; border-radius: 8px; padding: 12px 14px; }
  .kpi-lbl { font-size: 9px; letter-spacing: 0.12em; color: #7C8599; text-transform: uppercase; }
  .kpi-val { font-size: 22px; font-weight: 500; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .kpi-val.alert { color: #D62B2B; }

  .section-title { font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; color: #7C8599; margin: 14mm 0 4mm; border-top: 1px solid #E5E8EE; padding-top: 4mm; }

  .entry { border: 1px solid #E5E8EE; border-radius: 8px; margin-bottom: 6mm; overflow: hidden; page-break-inside: avoid; }
  .entry[data-alert="1"] { border-color: #F5A524; }
  .entry-head { display: flex; align-items: center; padding: 10px 14px; background: #FAFBFC; border-bottom: 1px solid #EEF0F4; gap: 12px; }
  .entry-num { font-family: ui-monospace, monospace; font-size: 11px; color: #7C8599; min-width: 26px; }
  .entry-meta { flex: 1; }
  .entry-pk { font-family: ui-monospace, monospace; font-size: 16px; font-weight: 500; letter-spacing: -0.01em; }
  .entry-sub { font-size: 11px; color: #7C8599; margin-top: 1px; }
  .entry-type { font-size: 9px; letter-spacing: 0.08em; padding: 3px 8px; border-radius: 4px; font-weight: 500; }
  .entry-type.alert { background: #FEF2E0; color: #B36F00; }
  .entry-type.photo { background: #E5EEFD; color: #0C447C; }
  .entry-type.normal { background: #E7F7EF; color: #0C6E3E; }
  .entry-img { text-align: center; background: #f8f9fb; padding: 4px; }
  .entry-img img { max-width: 100%; max-height: 90mm; object-fit: contain; }
  .entry-details { padding: 10px 14px; }
  .entry-note { font-size: 13px; margin-bottom: 8px; color: #1a1f2e; font-weight: 500; }
  .entry-table { width: 100%; font-size: 10px; border-collapse: collapse; }
  .entry-table td { padding: 3px 0; vertical-align: top; }
  .entry-table td:first-child { color: #7C8599; width: 40%; }
  .entry-table td:last-child { font-family: ui-monospace, monospace; }

  .footer { font-size: 9px; color: #7C8599; margin-top: 20mm; border-top: 1px solid #EEF0F4; padding-top: 4mm; font-family: ui-monospace, monospace; letter-spacing: 0.04em; }
</style>
</head>
<body>
<div class="cover">
  <div class="brand">PK Tracker Pro · Rapport de tournée</div>
  <div class="title">${escPDF(title)}</div>
  <div class="subtitle">${line ? line + ' · ' : ''}${range ? range + ' · ' : ''}${dateStr} · ${timeStr}</div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl">Points</div><div class="kpi-val">${sigs.length}</div></div>
    <div class="kpi"><div class="kpi-lbl">Photos</div><div class="kpi-val">${phs.length}</div></div>
    <div class="kpi"><div class="kpi-lbl">Alertes</div><div class="kpi-val alert">${alerts.length}</div></div>
    <div class="kpi"><div class="kpi-lbl">Date</div><div class="kpi-val" style="font-size:13px;padding-top:6px;">${dateStr.split(' ')[0]} ${dateStr.split(' ')[1]}</div></div>
  </div>
</div>

${alerts.length ? `<div class="section-title">Alertes · ${alerts.length}</div>` + alerts.map((s,i) => {
  const photo = photos[s.id];
  return `<div class="entry" data-alert="1">
    <div class="entry-head"><div class="entry-num">A${String(i+1).padStart(2,'0')}</div>
    <div class="entry-meta"><div class="entry-pk">PK ${escPDF(s.pk)}</div><div class="entry-sub">${escPDF(s.date_display)} · ${escPDF(s.ts_display)}</div></div>
    <div class="entry-type alert">ALERTE</div></div>
    ${photo ? `<div class="entry-img"><img src="${photo}" /></div>` : ''}
    <div class="entry-details">${s.note ? `<div class="entry-note">${escPDF(s.note)}</div>` : ''}</div>
  </div>`;
}).join('') : ''}

<div class="section-title">Relevés complets · ${sigs.length}</div>
${signalementsHtml}

<div class="footer">
  Document généré par PK Tracker Pro v6.0.0 · ${dateStr} ${timeStr}<br>
  Chaque entrée comporte une empreinte cryptographique SHA-256 (16 premiers caractères) garantissant l'intégrité des données à la saisie.
</div>
</body>
</html>`;
}

function escPDF(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' })[c]);
}

// ------ STRIDE CALIBRATION ------
window.openStrideCalib = async function() {
  const currentStride = PKT_TRACKER.getState().stride;
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Foulée actuelle</label>
      <div style="font-family:var(--ff-m);font-size:18px;color:var(--ink-0);">${currentStride.toFixed(2)} m</div>
    </div>
    <div style="font-size:13px;color:var(--ink-1);line-height:1.55;margin-bottom:14px;">
      Marchez une distance connue (idéalement 50 m mesurés au décamètre).<br>
      Saisissez ensuite la distance parcourue pour calibrer votre foulée.
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Régler manuellement</label>
      <input id="stride-manual" class="field" type="number" step="0.01" min="0.3" max="1.5" placeholder="0.72" inputmode="decimal" value="${currentStride.toFixed(2)}" />
    </div>`;
  const result = await sheet({
    title: 'Calibration foulée',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Enregistrer', value: 'save', primary: true }
    ]
  });
  if (result === 'save') {
    const v = parseFloat($('stride-manual').value);
    if (isNaN(v) || v < 0.3 || v > 1.5) { toast('Valeur invalide (0.3–1.5 m)', 'error'); return; }
    PKT_TRACKER.setStride(v);
    await PKT_DB.put(PKT_DB.STORES.meta, v, 'stride');
    $('stride-current').textContent = 'Actuelle : ' + v.toFixed(2) + ' m';
    toast('Foulée calibrée : ' + v.toFixed(2) + ' m', 'success');
  }
};

// ------ CLEAR EVERYTHING ------
window.clearEverything = async function() {
  const ok = await sheet({
    title: 'Tout effacer ?',
    body: 'Cette action supprime définitivement tous les chantiers, signalements et photos. Cette action ne peut pas être annulée.',
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Tout effacer', value: 'yes', danger: true }
    ]
  });
  if (ok !== 'yes') return;
  await PKT_DB.clear(PKT_DB.STORES.chantiers);
  await PKT_DB.clear(PKT_DB.STORES.signalements);
  await PKT_DB.clear(PKT_DB.STORES.photos);
  await PKT_DB.clear(PKT_DB.STORES.traces);
  toast('Données effacées', 'success');
  navigate('hub');
};

// ------ QUOTA DISPLAY ------
async function updateQuotaDisplay() {
  const q = await PKT_DB.getQuota();
  const el = $('quota-info');
  if (el && q.total) {
    const usedMb = (q.used / 1024 / 1024).toFixed(1);
    const totalMb = (q.total / 1024 / 1024).toFixed(0);
    el.textContent = 'Stockage : ' + usedMb + ' / ' + totalMb + ' Mo';
  }
}

// ------ SESSION INFO IN MENU ------
async function updateMenuSessionInfo() {
  const s = PKT_TRACKER.getSnapshot();
  const el = $('menu-session-info');
  if (!el) return;
  if (!s.active) {
    el.innerHTML = '<div style="font-size:13px;color:var(--ink-2);">Aucune session active</div>';
  } else {
    const chantier = app.chantierCourant?.name || 'Marche libre';
    el.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:3px;">${esc(chantier)}</div>
      <div style="font-family:var(--ff-m);font-size:12px;color:var(--ink-2);">PK ${s.pk.full} · ${s.dist<1000 ? Math.round(s.dist)+' m' : (s.dist/1000).toFixed(2)+' km'} · ${s.steps||0} pas</div>`;
  }
}

// ------ ICONS ------
function iconPlay() {
  return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/></svg>';
}
function iconStop() {
  return '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2"/></svg>';
}

// ------ INIT ------
async function init() {
  await PKT_DB.requestPersistence();
  // Load saved stride
  try {
    const stride = await PKT_DB.get(PKT_DB.STORES.meta, 'stride');
    if (stride) PKT_TRACKER.setStride(stride);
  } catch {}
  // Register service worker
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch {}
  }
  // Step count updates
  PKT_MOTION.onStep(() => {
    if (app.currentPage === 'track') refreshTrackingUI();
  });
  PKT_MOTION.onHeading((h) => {
    const s = PKT_TRACKER.getState();
    if (s.lastPos) {
      s.lastHeading = PKT_GEO.magneticToTrueBearing(h, s.lastPos.lat, s.lastPos.lon);
    }
  });
  navigate('hub');
}

document.addEventListener('DOMContentLoaded', init);

})();
