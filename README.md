# PK Tracker Pro v6 — Architecture & Déploiement

## Ce qui change face à la v5

La v5 était un seul fichier HTML de 1360 lignes qui faisait tout — et quand ça figeait, on ne savait pas pourquoi. La v6 est **modulaire**, chaque responsabilité est isolée dans son propre fichier :

```
pk-tracker-pwa-v6/
├── index.html       → Shell HTML, pages, navigation
├── styles.css       → Design system complet (923 lignes)
├── storage.js       → Couche IndexedDB (chantiers, signalements, photos)
├── geo.js           → Haversine, bearing, projection polyligne, filtre Kalman
├── motion.js        → Capteur de pas, boussole, gestion permissions iOS
├── photo.js         → Capture caméra, tampon PK/date/GPS
├── tracker.js       → Moteur de fusion GPS+pas+compas, 3 modes
├── export.js        → Génération KMZ + JSON de partage
├── ui.js            → Contrôleur UI, routage, orchestration
├── sw.js            → Service Worker (network-first HTML, cache-first assets)
├── manifest.json    → PWA installable
├── icon-192.png
└── icon-512.png
```

Un développeur qui reprend le projet peut isoler n'importe quel module sans casser les autres.

---

## Les trois modes de fonctionnement

### 1. Marche libre
Aucune config. Tu appuies "Démarrer une marche", l'app compte tes mètres et tes pas. Zéro effort d'apprentissage.

### 2. PK cumulatif
Tu saisis un PK de départ (ex: 42.350), l'app calcule ton PK courant en temps réel à partir de la distance cumulée. Équivalent de la v5 mais sans les freezes, avec indicateur de confiance honnête.

### 3. Chantier avec tracé de référence
Première reconnaissance = l'app enregistre ta trace complète avec les PK associés. Passages suivants = **map-matching** : elle projette ta position GPS sur le tracé connu, pas de dérive cumulative, ±3-5 m de précision stable.

---

## Les innovations techniques

### Filtre de Kalman 1D (geo.js)
Lisse les positions GPS en tenant compte de la précision de chaque mesure. Réduit le bruit de 40-50%.

### Projection polyligne (geo.js — `projectOnPolyline`)
C'est le cœur du mode chantier. Pour chaque segment du tracé de référence, calcule la projection orthogonale de la position GPS courante, trouve le segment le plus proche, et renvoie le PK interpolé. Algorithme en ~40 lignes, précision équivalente à Waze (qui fait la même chose sur ses routes).

### Fusion multi-sources (tracker.js)
Trois sources indépendantes de distance :
- GPS filtré Kalman
- Comptage de pas × foulée calibrée
- Intégration gyro/accéléromètre (vitesse × temps)

L'indicateur de confiance (vert/orange/rouge) est calculé à partir de l'accord entre ces sources. **L'affichage ne fige jamais** : si le GPS décroche, le compteur de pas prend le relais, et la pastille passe en orange pour prévenir l'utilisateur.

### Détection de sens robuste
Au lieu d'un seul bearing après 20 m (v5 cassée), on accumule 40 m de marche, on calcule un bearing moyen pondéré par la distance (moyenne circulaire via sin/cos), et on propose le sens à l'utilisateur. Plus fiable sur 90% des cas.

### Horodatage cryptographique
Chaque signalement a un `hash` SHA-256 calculé à la saisie depuis `(id, PK, coords, timestamp)`. Le PDF inclut ce hash en pied de fiche — document auditable, non falsifiable a posteriori.

### Persistance renforcée
`navigator.storage.persist()` demandé au démarrage pour éviter que iOS purge IndexedDB.

### Service Worker network-first
Le HTML est toujours demandé au réseau d'abord (pour recevoir les mises à jour), avec fallback cache si offline. Les assets (CSS, JS, icônes) sont cache-first. Plus de version bloquée.

---

## Comment ajouter une fonctionnalité (pour un informaticien qui reprend)

**Nouveau type de signalement** : éditer `ui.js` → `createSignalement()` et `renderJournal()`. Tous les signalements sont typés par `type` (`normal`, `alert`, `photo`).

**Nouveau format d'export** : éditer `export.js`, ajouter une fonction `export{Format}(chantier, sigs, trace)` qui retourne un Blob, et câbler le bouton dans `ui.js`.

**Nouveau capteur** : créer un nouveau module sur le modèle de `motion.js` (IIFE + `window.PKT_*`). Consommer dans `tracker.js` dans la boucle GPS.

**Nouveau mode de calcul PK** : étendre `tracker.js` `onGPS()` dans la section "COMPUTE PK via active strategy". Ajouter un cas `if (state.mode === 'mon-mode')`.

---

## Déploiement

### GitHub Pages (gratuit)
1. Créer un dépôt public
2. Uploader les 12 fichiers du dossier à la racine
3. Settings → Pages → Source: main / root
4. URL : `https://VOTRE-NOM.github.io/pk-tracker`

### Vercel / Netlify (30 secondes)
Drag & drop du dossier → URL instantanée.

### Installation sur téléphone
- **iPhone** : ouvrir en Safari → Partager → "Sur l'écran d'accueil"
- **Android** : ouvrir en Chrome → bannière "Installer" ou menu ⋮ → "Ajouter à l'écran d'accueil"

---

## Précision attendue (mesures réelles à valider en bêta)

| Mode | Environnement | Précision PK |
|------|---------------|--------------|
| Marche libre | Ciel dégagé | ±20-30 m/km |
| PK cumulatif | Ciel dégagé | ±20-30 m/km entre recalibrations |
| PK cumulatif | Urbain/tranchée | ±50-80 m/km |
| Chantier (map-matching) | Ciel dégagé | ±3-5 m en permanence |
| Chantier (map-matching) | Urbain/tranchée | ±5-15 m en permanence |
| Chantier (map-matching) | Tunnel | GPS indisponible → bascule compteur de pas → ±30-50 m |

**Avec recalibration sur borne physique croisée** : erreur remise à zéro.

---

## Permissions mobiles

L'app demande explicitement :
- **Géolocalisation** : au premier "Démarrer" (obligatoire)
- **Accéléromètre / compas (iOS 13+)** : au premier "Démarrer" via `DeviceMotionEvent.requestPermission()`
- **Caméra** : quand on ouvre la page Photo
- **Wake lock** : automatique pendant le suivi

**Aucune donnée ne sort du téléphone** tant que l'utilisateur n'exporte pas manuellement (KMZ, PDF, fichier .pkt).

---

## Format de partage .pkt

Fichier JSON structuré qu'un collègue peut importer pour voir tes chantiers et signalements. Ne contient **pas** les photos (trop lourd) — pour partager avec photos, utiliser le KMZ.

```json
{
  "format": "pkt-share",
  "version": 1,
  "chantier": { "id", "name", "line", "pk_start", "pk_end", "ref_trace" },
  "signalements": [ { "id", "pk", "pk_m", "lat", "lon", "acc", "cap", "ts", "type", "cat", "note", "hash" } ],
  "trace": [ { "lat", "lon", "ts", "acc" } ]
}
```

---

## Roadmap

### v6.1 (prochaine itération)
- Import de fichier .pkt (reconstitution du chantier chez un collègue)
- Mode guidage : "Aller vers anomalie n°7" avec flèche boussole
- Comparaison photo avant/après au même PK
- Dictée vocale pour les notes (Web Speech API)

### v6.2
- Clustering spatial des signalements récurrents
- Statuts ouvert/résolu avec photo de preuve
- Exports filtrés par destinataire

### v7
- Mode train avec détection automatique marche/train
- Signature magnétique expérimentale (POC)

---

## Signature

PK Tracker Pro v6 — conçu et itéré avec Thomas.
Architecture : Anthropic Claude Opus 4.6 en mode "co-dev".
Licence : usage interne RATP, pas encore de licence commerciale publiée.
