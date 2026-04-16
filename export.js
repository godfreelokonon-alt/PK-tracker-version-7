/* ==========================================================================
   EXPORT — KMZ (Google Earth), JSON share, PDF (via window.print)
   ========================================================================== */
(() => {
'use strict';

function xmlEsc(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, (c) => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'
  })[c]);
}

async function buildKMLContent(chantier, signalements, photos, trace) {
  const n = xmlEsc(chantier ? chantier.name : 'PK Tracker');
  const waypoints = await Promise.all(signalements.map(async (s, i) => {
    const hasPhoto = !!s.photo_id;
    let descHtml = '<![CDATA[';
    if (s.note) descHtml += '<p><strong>' + xmlEsc(s.note) + '</strong></p>';
    descHtml += '<p><b>PK :</b> ' + xmlEsc(s.pk) + '<br/>';
    descHtml += '<b>Heure :</b> ' + xmlEsc(s.ts_display) + ' (' + xmlEsc(s.date_display) + ')<br/>';
    if (s.cap != null) descHtml += '<b>Cap :</b> ' + s.cap + '°<br/>';
    if (s.acc != null) descHtml += '<b>Précision :</b> ±' + s.acc + ' m<br/>';
    descHtml += '<b>Type :</b> ' + xmlEsc(s.type);
    if (s.cat) descHtml += ' · ' + xmlEsc(s.cat);
    descHtml += '</p>';
    if (hasPhoto) descHtml += '<p><img src="images/' + s.id + '.jpg" width="640"/></p>';
    descHtml += ']]>';

    const style = s.type === 'alert' ? '#alertStyle' : hasPhoto ? '#photoStyle' : '#markStyle';
    return `
    <Placemark>
      <name>PK ${xmlEsc(s.pk)}${s.type==='alert'?' · ALERTE':''}</name>
      <description>${descHtml}</description>
      <styleUrl>${style}</styleUrl>
      <Point>
        <coordinates>${s.lon||0},${s.lat||0},0</coordinates>
      </Point>
    </Placemark>`;
  }));

  const traceKML = trace && trace.length > 1 ? `
    <Placemark>
      <name>Trace GPS</name>
      <styleUrl>#traceStyle</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${trace.map(p => p.lon+','+p.lat+',0').join(' ')}</coordinates>
      </LineString>
    </Placemark>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${n}</name>
  <description>Rapport PK Tracker · ${new Date().toLocaleString('fr-FR')}</description>
  <Style id="markStyle">
    <IconStyle><color>ff8CD910</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle>
  </Style>
  <Style id="photoStyle">
    <IconStyle><color>ffFF9D5B</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon></IconStyle>
  </Style>
  <Style id="alertStyle">
    <IconStyle><color>ff5A4CFF</color><scale>1.3</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-stars.png</href></Icon></IconStyle>
  </Style>
  <Style id="traceStyle">
    <LineStyle><color>ff10D981</color><width>3</width></LineStyle>
  </Style>
  ${traceKML}
  ${waypoints.join('\n')}
</Document>
</kml>`;
}

// Build KMZ using JSZip (loaded on-demand from CDN)
async function exportKMZ(chantier, signalements, trace) {
  if (typeof JSZip === 'undefined') {
    await loadJSZip();
  }
  const zip = new JSZip();
  const photos = {};
  const imgFolder = zip.folder('images');

  for (const s of signalements) {
    if (s.photo_id) {
      const data = await PKT_DB.get(PKT_DB.STORES.photos, s.photo_id);
      if (data) {
        photos[s.id] = data;
        const base64 = data.split(',')[1];
        imgFolder.file(s.id + '.jpg', base64, { base64: true });
      }
    }
  }

  const kml = await buildKMLContent(chantier, signalements, photos, trace);
  zip.file('doc.kml', kml);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return blob;
}

function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (typeof JSZip !== 'undefined') return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// JSON share format — for agent-to-agent transfer
function buildShareJSON(chantier, signalements, trace) {
  return {
    format: 'pkt-share',
    version: 1,
    generated_at: new Date().toISOString(),
    chantier: chantier ? {
      id: chantier.id,
      name: chantier.name,
      line: chantier.line,
      pk_start: chantier.pk_start,
      pk_end: chantier.pk_end,
      ref_trace: chantier.ref_trace
    } : null,
    signalements: signalements.map(s => ({
      id: s.id, pk: s.pk, pk_m: s.pk_m,
      lat: s.lat, lon: s.lon, acc: s.acc, cap: s.cap,
      ts: s.ts, type: s.type, cat: s.cat, note: s.note,
      has_photo: !!s.photo_id, hash: s.hash
    })),
    trace: trace
  };
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.PKT_EXPORT = {
  exportKMZ, buildShareJSON, downloadBlob
};

})();
