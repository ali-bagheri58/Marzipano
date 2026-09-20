// The local worker URL is resolved by Vite at build time and bundled as a
// separate chunk — no external network request needed.
const LOCAL_EQUIRECT_WORKER_URL = new URL('./equirect.worker.js', import.meta.url);

function buildEquirectLevels(faceSize) {
  const levels = [];
  let exponent = 0;
  const baseSize = 512;

  while (baseSize * (2 ** exponent) <= faceSize) {
    levels.push({ tileSize: 512, size: baseSize * (2 ** exponent) });
    exponent += 1;
  }

  if (!levels.length) levels.push({ tileSize: 512, size: 512 });
  const nextSize = baseSize * (2 ** exponent);
  if (levels[levels.length - 1].size * 1.25 < faceSize) levels.push({ tileSize: 512, size: nextSize });
  return levels;
}

export async function generateOfficialEquirectTiles(file, { onProgress } = {}) {
  if (!(file instanceof File)) throw new Error('An equirectangular image file is required');

  const image = await createImageBitmap(file);
  const width = image.width;
  const height = image.height;
  image.close();

  // Accept images whose shorter dimension × 2 ≈ longer dimension (within 2%).
  // Pure 2:1 check rejected perfectly valid 360° photos from certain cameras.
  const ratio = width / height;
  if (ratio < 1.96 || ratio > 2.04) {
    throw new Error(
      `Equirectangular images should have a 2:1 aspect ratio (got ${width}×${height}, ratio ${ratio.toFixed(3)})`
    );
  }

  // Normalise dimensions to a strict 2:1 so the worker doesn't have to worry.
  const normW = width;
  const normH = Math.round(width / 2);

  const faceSize = Math.ceil(normW / 4);
  const levels = buildEquirectLevels(faceSize);

  const worker = new Worker(LOCAL_EQUIRECT_WORKER_URL, { type: 'module' });

  try {
    const result = await new Promise((resolve, reject) => {
      const tiles = [];
      worker.addEventListener('message', (event) => {
        const message = event.data || {};
        if (message.msg === 'tile') {
          tiles.push({ level: message.level, face: message.face, y: message.v, x: message.h, data: message.tileArray });
          // Per-tile progress: map 0→totalTiles to 20→90%
          if (typeof onProgress === 'function' && message.totalTiles > 0) {
            const pct = 20 + Math.round((message.completedTiles / message.totalTiles) * 70);
            onProgress(pct);
          }
        } else if (message.msg === 'progress') {
          // completedLevels / totalLevels → map to 40–90% range (legacy fallback)
          if (typeof onProgress === 'function') {
            const pct = 40 + Math.round((message.completedLevels / message.totalLevels) * 50);
            onProgress(pct);
          }
        } else if (message.msg === 'done') {
          resolve({ tiles, preview: message.cubeMapPreviewArray || null });
        } else if (message.msg === 'error') {
          reject(new Error(`Equirect worker error: ${message.error}`));
        }
      });
      worker.addEventListener('messageerror', () => reject(new Error('Equirect worker returned an uncloneable message')));
      worker.addEventListener('error', (event) => {
        const details = event.error?.message || event.message || 'unknown worker error';
        reject(new Error(`Equirect worker failed: ${details}`));
      });
      // Pass normalised dimensions so the worker renders into a clean 2:1 canvas.
      worker.postMessage({
        fileData: { file, width: normW, height: normH },
        levels,
        cubeMapPreviewSize: 256,
        cubeMapPreviewFaceOrder: 'bdflru',
      });
    });

    return { faceSize, levels, ...result };
  } finally {
    worker.terminate();
  }
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file for preview'));
    reader.readAsDataURL(file);
  });
}

export function splitCubePreviewFaces(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const size = Math.floor(image.height / 6);
      const faces = {};

      'bdflru'.split('').forEach((face, index) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, index * size, size, size, 0, 0, size, size);
        faces[face] = canvas.toDataURL('image/jpeg', 0.92);
      });

      resolve(faces);
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

export function buildMarzipanoDataJs(exportTargets = []) {
  const scenes = exportTargets.map((target) => {
    // Ensure the levels array always starts with a fallback level at index 0.
    // Tiles are written with index 1, 2, ... (index 0 reserved for the preview fallback).
    // CubeGeometry in index.js uses these levels directly, so index must match file paths.
    let levels = target.levels;
    if (levels && levels.length && !levels[0].fallbackOnly) {
      levels = [{ tileSize: 256, size: 256, fallbackOnly: true }, ...levels];
    }
    if (!levels) {
      levels = [
        { tileSize: 256, size: 256, fallbackOnly: true },
        { tileSize: 512, size: 512 },
        { tileSize: 512, size: 1024 },
        { tileSize: 512, size: 2048 },
        { tileSize: 512, size: 4096 }
      ];
    }
    return {
      id: target.key,
      name: target.label || target.key,
      geometryType: target.geometryType || 'cube',
      equirectUrl: target.geometryType === 'equirect' ? (target.previewUrl || `./tiles/${target.key}/preview.jpg`) : null,
      levels,
      faceSize: target.faceSize || 2976,
      initialViewParameters: target.initialViewParameters || {
        pitch: Number(target.pitch) || 0,
        yaw: Number(target.yaw) || 0,
        fov: Number(target.fov) || Math.PI / 2
      },
      sceneSound: target.sceneSound || null,
      sceneVideo: target.sceneVideo || null,
      linkHotspots: (target.hotspots || []).map((hotspot) => ({
        yaw: hotspot.yaw || 0,
        pitch: hotspot.pitch || 0,
        rotation: hotspot.rotation || 0,
        target: hotspot.target || target.key,
        text: hotspot.label || 'Hotspot',
        sizePercent: Math.min(200, Math.max(50, Number(hotspot.sizePercent) || 100)),
        targetViewParameters: {
          yaw: Number(hotspot.targetYaw ?? hotspot.targetViewParameters?.yaw ?? 0),
          pitch: Number(hotspot.targetPitch ?? hotspot.targetViewParameters?.pitch ?? 0),
          fov: Number(hotspot.targetFov ?? hotspot.targetViewParameters?.fov ?? 120)
        },
        sound: hotspot.sound || null
      })),
      infoHotspots: []
    };
  });

  const projectDetails = exportTargets[0]?.projectDetails || {};
  return `var APP_DATA = ${JSON.stringify({ scenes, projectDetails, name: 'Project Title', settings: { mouseViewMode: 'drag', autorotateEnabled: true, fullscreenButton: false, viewControlButtons: false } }, null, 2)};`;
}

export function buildExportChatScript(projectDetails = null) {
  const serializedDetails = projectDetails ? JSON.stringify(projectDetails) : '((window.APP_DATA && window.APP_DATA.projectDetails) || {})';
  return `(function() {
  var details = ${serializedDetails};
  var labels = { type: 'Property type', area: 'Living area', rooms: 'Rooms', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', floor: 'Floor', floors: 'Total floors', yearBuilt: 'Year built', parkingSpaces: 'Parking spaces', storageRoom: 'Storage room', climate: 'Heating / cooling', energyCost: 'Energy cost', energyConsumption: 'Energy consumption', price: 'Price', address: 'Address', description: 'Description' };
  var aliases = { type: ['property type', 'type', 'immobilienart'], area: ['area', 'size', 'wohnfläche', 'sqm'], rooms: ['room', 'rooms', 'zimmer'], bedrooms: ['bedroom', 'bedrooms', 'schlaf'], bathrooms: ['bathroom', 'bathrooms', 'bad'], floor: ['floor', 'etage'], floors: ['total floors', 'floors', 'stockwerke'], yearBuilt: ['year built', 'built', 'baujahr'], parkingSpaces: ['parking', 'parking spaces', 'stellplatz'], storageRoom: ['storage', 'storage room', 'keller'], climate: ['heating', 'cooling', 'heating / cooling', 'heizung'], energyCost: ['energy cost', 'energy price', 'energie kosten', 'stromkosten'], energyConsumption: ['energy consumption', 'verbrauch', 'energieverbrauch'], price: ['price', 'cost', 'preis'], address: ['address', 'adresse'], description: ['description', 'beschreib'] };
  var filledKeys = Object.keys(labels).filter(function(key) { return details[key] !== undefined && details[key] !== null && String(details[key]).trim() !== ''; });
  var filledLabels = filledKeys.map(function(key) { return labels[key]; });
  var text = function(value) { return value === undefined || value === null || String(value).trim() === '' ? 'No information has been entered yet.' : String(value); };
  var answer = function(question) {
    var query = String(question || '').toLowerCase();
    var key = Object.keys(aliases).find(function(name) { return aliases[name].some(function(alias) { return query.indexOf(alias) >= 0; }); });
    if (key && filledKeys.indexOf(key) >= 0) return '<strong>' + labels[key] + ':</strong> ' + text(details[key]);
    if (/hello|hallo|hi|hey|سلام/.test(query)) return 'Hello. I can answer questions about this property using the available project data.';
    if (/all|overview|details|informationen|daten|مشخصات/.test(query)) return Object.keys(labels).filter(function(key) { return details[key] !== undefined && String(details[key]).trim() !== ''; }).map(function(key) { return '<strong>' + labels[key] + ':</strong> ' + text(details[key]); }).join('<br>') || 'No property details have been entered yet.';
    return filledLabels.length ? 'I can help with: ' + filledLabels.join(', ') + '.' : 'No property details have been entered yet.';
  };
  var style = document.createElement('style');
  style.textContent = '.property-chat-launcher{position:fixed;right:18px;top:68px;z-index:50;width:52px;height:52px;border:0;border-radius:50%;background:#d8fa5a;color:#11150c;font-size:23px;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer}.property-chat-panel{position:fixed;right:18px;top:134px;bottom:auto;z-index:50;width:min(380px,calc(100vw - 28px));max-height:calc(100vh - 150px);display:none;flex-direction:column;overflow:hidden;border:1px solid rgba(216,250,90,.35);border-radius:24px;background:#151a20;color:#f1f2ef;box-shadow:0 20px 55px rgba(0,0,0,.45);font-family:Segoe UI,sans-serif;direction:ltr}.property-chat-panel.is-open{display:flex}.property-chat-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.1);background:linear-gradient(135deg,#203b35,#151a20)}.property-chat-kicker{color:#9ed9b8;font-size:11px;letter-spacing:.14em}.property-chat-title{margin:4px 0 0;font-size:19px}.property-chat-close{width:34px;height:34px;border:0;border-radius:50%;background:#293039;color:#fff;font-size:22px;cursor:pointer}.property-chat-messages{display:flex;flex:1;flex-direction:column;gap:10px;overflow:auto;padding:16px}.property-chat-message{max-width:92%;padding:12px 14px;border-radius:16px;background:#292e36;font-size:14px;line-height:1.5}.property-chat-message.user{align-self:flex-end;background:#d8fa5a;color:#11150c}.property-chat-message.thinking{color:#aeb6bf}.property-chat-message.thinking::after{content:"...";display:inline-block;width:18px;overflow:hidden;vertical-align:bottom;animation:property-chat-dots 1.2s steps(4,end) infinite}@keyframes property-chat-dots{0%{width:0}100%{width:18px}}.property-chat-suggestions{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px}.property-chat-suggestion{padding:8px 11px;border:0;border-radius:18px;background:#292e36;color:#f1f2ef;font-size:12px;cursor:pointer}.property-chat-form{display:flex;gap:8px;padding:12px 16px 16px;border-top:1px solid rgba(255,255,255,.1)}.property-chat-input{min-width:0;flex:1;padding:11px 12px;border:1px solid rgba(255,255,255,.15);border-radius:12px;background:#20252d;color:#fff;outline:0}.property-chat-submit{padding:0 14px;border:0;border-radius:12px;background:#d8fa5a;color:#11150c;font-weight:700;cursor:pointer}@media (max-width:600px){.property-chat-launcher{top:68px;right:10px;width:46px;height:46px}.property-chat-panel{top:126px;right:10px;max-height:calc(100vh - 140px)}}';
  document.head.appendChild(style);
  var launcher = document.createElement('button'); launcher.className = 'property-chat-launcher'; launcher.type = 'button'; launcher.setAttribute('aria-label', 'Open property assistant'); launcher.textContent = '✦';
  var panel = document.createElement('section'); panel.className = 'property-chat-panel'; panel.setAttribute('aria-label', 'Property assistant');
  panel.innerHTML = '<header class="property-chat-head"><div><div class="property-chat-kicker">PROPERTY ASSISTANT</div><h2 class="property-chat-title">AI assistant for this property</h2></div><button class="property-chat-close" type="button" aria-label="Close">×</button></header><div class="property-chat-messages"></div><div class="property-chat-suggestions"></div><form class="property-chat-form"><input class="property-chat-input" placeholder="Ask about this property..." autocomplete="off"><button class="property-chat-submit" type="submit">Send</button></form>';
  var messages = panel.querySelector('.property-chat-messages');
  var input = panel.querySelector('.property-chat-input');
  var suggestions = panel.querySelector('.property-chat-suggestions');
  filledKeys.forEach(function(key) { var button = document.createElement('button'); button.className = 'property-chat-suggestion'; button.type = 'button'; button.textContent = labels[key]; suggestions.appendChild(button); });
  var addMessage = function(content, user, thinking) { var node = document.createElement('div'); node.className = 'property-chat-message' + (user ? ' user' : '') + (thinking ? ' thinking' : ''); node.innerHTML = content; messages.appendChild(node); messages.scrollTop = messages.scrollHeight; return node; };
  var ask = function(value) { var question = String(value || '').trim(); if (!question) return; addMessage(question.replace(/[&<>]/g, function(char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]; }), true); var thinking = addMessage('Reading property data', false, true); var statuses = ['Reading property data', 'Checking available real-estate records', 'Comparing building details', 'Preparing the answer']; var statusIndex = 0; var statusTimer = window.setInterval(function() { statusIndex = Math.min(statusIndex + 1, statuses.length - 1); thinking.firstChild ? thinking.firstChild.nodeValue = statuses[statusIndex] : thinking.textContent = statuses[statusIndex]; }, 620); window.setTimeout(function() { window.clearInterval(statusTimer); thinking.classList.remove('thinking'); thinking.innerHTML = answer(question); messages.scrollTop = messages.scrollHeight; }, 2200 + Math.floor(Math.random() * 1200)); };
  addMessage(filledLabels.length ? 'Hello. I can answer questions about ' + filledLabels.join(', ') + '.' : 'No property details have been entered yet.', false);
  panel.querySelector('.property-chat-close').addEventListener('click', function() { panel.classList.remove('is-open'); });
  launcher.addEventListener('click', function() { panel.classList.toggle('is-open'); if (panel.classList.contains('is-open')) input.focus(); });
  panel.querySelectorAll('.property-chat-suggestion').forEach(function(button) { button.addEventListener('click', function() { ask(button.textContent); }); });
  panel.querySelector('.property-chat-form').addEventListener('submit', function(event) { event.preventDefault(); var value = input.value; input.value = ''; ask(value); });
  document.body.appendChild(launcher); document.body.appendChild(panel);
})();`;
}

export function buildExportHtml(exportTargets, sceneName, tileUrlMap = {}, marzipanoScript = '', scriptMode = 'inline') {
  const serializedTileMap = JSON.stringify(tileUrlMap || {});
  const marzipanoLoaderTag = scriptMode === 'inline' && marzipanoScript
    ? `<script>${marzipanoScript}</script>`
    : '<script src="/node_modules/marzipano/dist/marzipano.js"></script>';

  return `<!DOCTYPE html>
<html lang="fa">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${sceneName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: #0a0e11;
      color: #fff;
      font-family: "Segoe UI", sans-serif;
      display: flex;
      direction: rtl;
    }
    .sidebar {
      width: 260px;
      background: #111618;
      border-left: 1px solid rgba(255,255,255,0.08);
      overflow-y: auto;
      padding: 12px;
    }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      margin-bottom: 10px;
      padding: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.02);
      color: white;
      cursor: pointer;
      text-align: right;
    }
    .menu-item.is-active { border-color: #d8fa5a; background: rgba(216,250,90,0.08); }
    .thumb { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; background: #1a2022; }
    .menu-label { font-size: 12px; }
    .viewer-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
      height: 100vh;
      min-height: 100vh;
      background: #0b1012;
    }
    #viewer { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 100vh; overflow: hidden; }
    .view-coordinates {
      position: absolute;
      z-index: 10;
      top: 14px;
      left: 14px;
      padding: 7px 10px;
      border: 1px solid rgba(216, 250, 90, 0.42);
      background: rgba(10, 14, 17, 0.82);
      color: #d8fa5a;
      font: 11px/1.4 'DM Mono', monospace;
      direction: ltr;
      pointer-events: none;
    }
    canvas { display: block; width: 100%; height: 100%; }
    .hotspot-object {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 60px;
      height: 60px;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
      opacity: 0.9;
      transition: opacity 0.2s;
    }
    .hotspot-object:hover, .hotspot-object:focus {
      opacity: 1;
    }
    .hotspot-object-icon {
      display: block;
      width: 60px;
      height: 60px;
      object-fit: contain;
    }
    .hotspot-object-core {
      position: relative;
      display: block;
      width: 48px;
      height: 48px;
      border: 7px solid #fff;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.2);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
    }
    .hotspot-object-core::after {
      content: '';
      position: absolute;
      left: 50%;
      top: 50%;
      width: 28px;
      height: 25px;
      background: #fff;
      clip-path: polygon(50% 0, 100% 40%, 82% 60%, 62% 42%, 62% 100%, 38% 100%, 38% 42%, 18% 60%, 0 40%);
      transform: translate(-50%, -50%);
    }
    .hotspot-object-label {
      position: absolute;
      top: -30px;
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      padding: 4px 8px;
      border: 1px solid rgba(216, 250, 90, 0.4);
      background: rgba(16, 19, 22, 0.88);
      color: #f1f2ef;
      font-size: 10px;
      font-family: 'DM Mono', monospace;
      letter-spacing: .04em;
      opacity: 0;
      transition: opacity .18s ease;
    }
    .hotspot-object:hover .hotspot-object-label,
    .hotspot-object:focus .hotspot-object-label {
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="sidebar" id="menu"></div>
  <div class="viewer-wrap"><div id="viewer"></div><div class="view-coordinates" id="view-coordinates">X: 0.00 | Y: 0.00</div></div>

  <script>
    const panoramas = ${JSON.stringify(exportTargets, null, 2)};
    const tileUrlMap = ${serializedTileMap};
    const hotspotIconUrl = tileUrlMap.__hotspotIcon || '';
  </script>
  ${marzipanoLoaderTag}
  <script>
    function renderFallbackPreview(item) {
      const host = document.getElementById('viewer');
      if (!host) return;
      host.innerHTML = '';
      host.style.position = 'relative';
      const image = document.createElement('img');
      image.src = item.previewUrl || '';
      image.alt = item.label || 'Panorama';
      image.style.position = 'absolute';
      image.style.inset = '0';
      image.style.width = '100%';
      image.style.height = '100%';
      image.style.objectFit = 'cover';
      image.style.display = 'block';
      host.appendChild(image);

      const hotspots = Array.isArray(item.hotspots) ? item.hotspots : [];
      hotspots.forEach((hotspot) => {
        const yaw = Number(hotspot.yaw || 0);
        const pitch = Number(hotspot.pitch || 0);
        const marker = document.createElement('div');
        marker.className = 'hotspot-object';
        marker.style.transform = 'translate(-50%, -50%)';
        marker.style.position = 'absolute';
        marker.style.left = ((yaw + Math.PI) / (Math.PI * 2) * 100) + '%';
        marker.style.top = ((Math.PI / 2 - pitch) / Math.PI * 100) + '%';
        marker.title = (hotspot.label || 'Hotspot') + ' | X: ' + yaw.toFixed(2) + ' | Y: ' + pitch.toFixed(2);

        if (hotspotIconUrl) {
          const icon = document.createElement('img');
          icon.className = 'hotspot-object-icon';
          icon.src = hotspotIconUrl;
          icon.alt = '';
          icon.style.transform = 'scale(' + Math.min(2, Math.max(.5, Number(hotspot.sizePercent || 100) / 100)) + ') rotate(' + Number(hotspot.rotation || 0) + 'rad)';
          marker.appendChild(icon);
        } else {
          const core = document.createElement('span');
          core.className = 'hotspot-object-core';
          core.style.transform = 'scale(' + Math.min(2, Math.max(.5, Number(hotspot.sizePercent || 100) / 100)) + ') rotate(' + Number(hotspot.rotation || 0) + 'rad)';
          marker.appendChild(core);
        }

        const label = document.createElement('span');
        label.className = 'hotspot-object-label';
        label.textContent = (hotspot.label || 'Hotspot') + ' | X: ' + yaw.toFixed(2) + ' | Y: ' + pitch.toFixed(2);
        marker.appendChild(label);
        host.appendChild(marker);
      });
    }

    window.addEventListener('load', () => {
      try {
        const viewer = new Marzipano.Viewer(document.getElementById('viewer'), { stage: { progressive: true } });
        let activeScene = null;

        function createSceneFor(item) {
          if (activeScene) {
            try { viewer.destroyScene(activeScene); } catch (err) {}
          }

          let source;
          let geometry;
          if (item.geometryType === 'equirect') {
            source = new Marzipano.ImageUrlSource(function() {
              return { url: item.previewUrl || '' };
            });
            geometry = new Marzipano.EquirectGeometry([
              { tileSize: 1024, size: 1024 },
              { tileSize: 1024, size: 2048 }
            ]);
          } else {
            source = new Marzipano.ImageUrlSource((tile) => {
              const suffix = tile.z + '/' + tile.face + '/' + tile.y + '/' + tile.x;
              const candidates = [
                item.id + '/' + suffix + '.jpg',
                item.id + '/' + suffix + '.png',
                suffix + '.jpg',
                suffix + '.png',
                suffix + '.jpeg'
              ];
              const url = candidates.map((key) => tileUrlMap[key]).find(Boolean);
              return { url: url || item.previewUrl || '' };
            });
            geometry = new Marzipano.CubeGeometry(
              (item.levels && item.levels.length)
                ? item.levels
                : [
                    { tileSize: 256, size: 256, fallbackOnly: true },
                    { tileSize: 512, size: 512 },
                    { tileSize: 512, size: 1024 },
                    { tileSize: 512, size: 2048 }
                  ]
            );
          }

          const view = new Marzipano.RectilinearView({ yaw: Number(item.yaw || 0), pitch: Number(item.pitch || 0), fov: 100 * Math.PI / 180 }, Marzipano.RectilinearView.limit.traditional(2048, 120 * Math.PI / 180));
          const coordinates = document.getElementById('view-coordinates');
          const updateCoordinates = () => { if (coordinates) { const current = view.parameters(); coordinates.textContent = 'X: ' + Number(current.yaw || 0).toFixed(2) + ' | Y: ' + Number(current.pitch || 0).toFixed(2); } };
          view.addEventListener('change', updateCoordinates);
          updateCoordinates();

          const scene = viewer.createScene({ source, geometry, view, pinFirstLevel: true });
          activeScene = scene;

          const hotspots = Array.isArray(item.hotspots) ? item.hotspots : [];
          if (hotspots.length) {
            const container = scene.hotspotContainer();
            hotspots.forEach((hotspot) => {
              const marker = document.createElement('div');
              marker.className = 'hotspot-object';
              const hotspotScale = Math.min(2, Math.max(.5, Number(hotspot.sizePercent || 100) / 100));
              marker.setAttribute('role', 'button');
              marker.setAttribute('tabindex', '0');
              marker.title = hotspot.label || 'Hotspot';

              if (hotspotIconUrl) {
                const icon = document.createElement('img');
                icon.className = 'hotspot-object-icon';
                icon.src = hotspotIconUrl;
                icon.alt = '';
                icon.style.transform = 'scale(' + hotspotScale + ') rotate(' + Number(hotspot.rotation || 0) + 'rad)';
                marker.appendChild(icon);
              } else {
                const core = document.createElement('span');
                core.className = 'hotspot-object-core';
                core.style.transform = 'scale(' + hotspotScale + ') rotate(' + Number(hotspot.rotation || 0) + 'rad)';
                marker.appendChild(core);
              }

              const label = document.createElement('span');
              label.className = 'hotspot-object-label';
              label.textContent = (hotspot.label || 'Hotspot') + '\nX: ' + Number(hotspot.yaw || 0).toFixed(2) + '\nY: ' + Number(hotspot.pitch || 0).toFixed(2);
              marker.appendChild(label);
              marker.title = label.textContent;

              container.createHotspot(marker, { yaw: Number(hotspot.yaw || 0), pitch: Number(hotspot.pitch || 0) });
            });
          }
          scene.switchTo();
        }

        const marzipanoMenu = document.getElementById('menu');
        panoramas.forEach((item, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'menu-item' + (index === 0 ? ' is-active' : '');
          btn.innerHTML = '<img class="thumb" src="' + (item.previewUrl || '') + '" /><span class="menu-label">' + item.label + '</span>';
          btn.addEventListener('click', () => {
            marzipanoMenu.querySelectorAll('.menu-item').forEach((el) => el.classList.remove('is-active'));
            btn.classList.add('is-active');
            createSceneFor(item);
          });
          marzipanoMenu.appendChild(btn);
        });

        if (panoramas.length) createSceneFor(panoramas[0]);
      } catch (error) {
        if (panoramas.length) renderFallbackPreview(panoramas[0]);
      }
    });
  </script>
  <script>${buildExportChatScript(exportTargets[0]?.projectDetails || {})}</script>
</body>
</html>`;
}

export function buildStandaloneMarzipanoIndexHtml(exportTargets = []) {
  const sceneLinks = exportTargets.map((target) => `      <a href="javascript:void(0)" class="scene" data-id="${target.key}"><li class="text">${target.label || target.key}</li></a>`).join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<title>Project Title</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="vendor/reset.min.css">
<link rel="stylesheet" href="style.css">
</head>
<body class="multiple-scenes">
<div id="pano"></div>
<div id="sceneList"><ul class="scenes">
${sceneLinks}
</ul></div>
<div id="titleBar"><h1 class="sceneName"></h1></div>
<script src="vendor/marzipano.js"></script>
<script src="data.js"></script>
<script src="index.js"></script>
</body>
</html>`;
}

export function buildMarzipanoIndexHtml(indexHtml, exportTargets = []) {
  const sceneLinks = exportTargets.map((target) => `      <a href="javascript:void(0)" class="scene" data-id="${target.key}">
        <li class="text">${target.label || target.key}</li>
      </a>`).join('\n');
  return indexHtml.replace(/(<ul class="scenes">)[\s\S]*?(<\/ul>)/, `$1\n${sceneLinks}\n  $2`);
}

export function buildTemplatePreviewScript(exportTargets, tileUrlMap) {
  const serializedTargets = JSON.stringify(exportTargets);
  const serializedTiles = JSON.stringify(tileUrlMap || {});
  return `(function() {
  var panoramas = ${serializedTargets};
  var tiles = ${serializedTiles};
  var activeHotspotAudio = null;
  var activeSceneVideo = null;
  var activeSceneVideoWrap = null;
  var activeSceneAudio = null;
  function playHotspotSound(hotspot) {
    if (!hotspot.sound || !hotspot.sound.url) return;
    if (activeHotspotAudio) { activeHotspotAudio.pause(); activeHotspotAudio.currentTime = 0; }
    activeHotspotAudio = new Audio(hotspot.sound.url);
    activeHotspotAudio.loop = Boolean(hotspot.sound.loop);
    activeHotspotAudio.play().catch(function() {});
  }
  function playSceneVideo(item) {
    if (activeSceneVideoWrap) {
      activeSceneVideo.pause();
      activeSceneVideoWrap.remove();
      activeSceneVideo = null;
      activeSceneVideoWrap = null;
    }
    if (!item.data.sceneVideo || !item.data.sceneVideo.url) return;
    var wrapper = document.createElement('div');
    wrapper.className = 'scene-avatar-video-wrap';
    activeSceneVideo = document.createElement('video');
    activeSceneVideo.className = 'scene-avatar-video';
    activeSceneVideo.src = item.data.sceneVideo.url;
    activeSceneVideo.autoplay = false;
    activeSceneVideo.muted = false;
    activeSceneVideo.loop = false;
    activeSceneVideo.playsInline = true;
    activeSceneVideo.controls = false;
    var closeButton = document.createElement('button');
    closeButton.className = 'scene-avatar-video-close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    function closeSceneVideo() {
      activeSceneVideo.pause();
      wrapper.remove();
      if (activeSceneVideoWrap === wrapper) {
        activeSceneVideo = null;
        activeSceneVideoWrap = null;
      }
    }
    closeButton.addEventListener('click', function() {
      closeSceneVideo();
    });
    activeSceneVideo.addEventListener('ended', closeSceneVideo, { once: true });
    wrapper.appendChild(activeSceneVideo);
    wrapper.appendChild(closeButton);
    activeSceneVideoWrap = wrapper;
    document.body.appendChild(wrapper);
  }
  function stopSceneSound() {
    if (!activeSceneAudio) return;
    activeSceneAudio.pause();
    activeSceneAudio.currentTime = 0;
    activeSceneAudio = null;
  }
  function playSceneSound(item) {
    stopSceneSound();
    if (!item.data.sceneSound || !item.data.sceneSound.url) return;
    activeSceneAudio = new Audio(item.data.sceneSound.url);
    activeSceneAudio.loop = Boolean(item.data.sceneSound.loop);
    activeSceneAudio.play().catch(function() {});
  }
  var viewer = new Marzipano.Viewer(document.getElementById('pano'));
  var scenes = panoramas.map(function(data) {
    var source = new Marzipano.ImageUrlSource(function(tile) {
      var level = Number(tile.z || 0);
      var face = String(tile.face || '').toLowerCase();
      var row = Number(tile.y || 0);
      var column = Number(tile.x || 0);
      var url = '';
      var suffixes = [level + '/' + face + '/' + row + '/' + column + '.jpg', level + '/' + face + '/' + row + '/' + column + '.png'];
      suffixes.some(function(suffix) {
        url = tiles[data.key + '/' + suffix] || tiles[suffix];
        return Boolean(url);
      });
      return { url: url || data.previewUrl };
    });
    var view = new Marzipano.RectilinearView({ yaw: data.yaw || 0, pitch: data.pitch || 0, fov: (data.fov || 1.5707963267948966) }, Marzipano.RectilinearView.limit.traditional(2976, 100 * Math.PI / 180, 120 * Math.PI / 180));
    var scene = viewer.createScene({ source: source, geometry: new Marzipano.CubeGeometry([{ tileSize: 256, size: 256, fallbackOnly: true }]), view: view, pinFirstLevel: true });
    (data.hotspots || []).forEach(function(hotspot) {
      var marker = document.createElement('div');
      marker.className = 'link-hotspot';
      var hotspotScale = Math.min(2, Math.max(0.5, Number(hotspot.sizePercent || 100) / 100));
      var hotspotSize = (window.matchMedia && window.matchMedia('(max-width: 500px)').matches ? 70 : 60) * hotspotScale;
      marker.style.width = hotspotSize + 'px';
      marker.style.height = hotspotSize + 'px';
      marker.style.marginLeft = (-hotspotSize / 2) + 'px';
      marker.style.marginTop = (-hotspotSize / 2) + 'px';
      marker.dataset.target = hotspot.target || '';
      marker.dataset.targetYaw = hotspot.targetYaw || 0;
      marker.dataset.targetPitch = hotspot.targetPitch || 0;
      marker.dataset.sound = hotspot.sound ? 'true' : 'false';
      marker._hotspotSound = hotspot.sound || null;
      var icon = document.createElement('img');
      icon.src = '/marzipano-template/app-files/img/link.png';
      icon.className = 'link-hotspot-icon';
      icon.style.transform = 'rotate(' + (hotspot.rotation || 0) + 'rad)';
      marker.appendChild(icon);
      scene.hotspotContainer().createHotspot(marker, { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });
    return { data: data, scene: scene };
  });
  function switchScene(item) {
    if (activeHotspotAudio) { activeHotspotAudio.pause(); activeHotspotAudio.currentTime = 0; activeHotspotAudio = null; }
    stopSceneSound();
    item.scene.switchTo();
    document.querySelector('.sceneName').textContent = item.data.label || item.data.key;
    document.querySelectorAll('#sceneList .scene').forEach(function(element) { element.classList.toggle('current', element.getAttribute('data-id') === item.data.key); });
    playSceneSound(item);
    playSceneVideo(item);
  }
  scenes.forEach(function(item) { var element = document.querySelector('#sceneList .scene[data-id="' + item.data.key + '"]'); if (element) element.addEventListener('click', function() { switchScene(item); }); });
  if (scenes.length) switchScene(scenes[0]);
})();`;
}

export function buildPreviewAssetMap(panoramaFileGroups) {
  return Promise.all(
    [...panoramaFileGroups.values()].flat().map(async (file) => {
      const relative = (file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
      const segments = relative.split('/').filter(Boolean);
      const tileIndex = segments.findIndex((segment) => /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment));
      if (tileIndex <= 0) return null;
      const suffix = segments.slice(tileIndex).join('/');
      if (!/\.(jpe?g|png)$/i.test(suffix)) return null;
      return [suffix, await readFileAsDataUrl(file)];
    })
  ).then((entries) => Object.fromEntries(entries.filter(Boolean)));
}

export function buildExportTileUrlMap(exportTargets = [], files = []) {
  const map = {};
  files.forEach((file) => {
    const relative = (file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
    const segments = relative.split('/').filter(Boolean);
    const tileIndex = segments.findIndex((segment) => /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment));
    if (tileIndex <= 0) return;
    const suffix = segments.slice(tileIndex).join('/');
    if (!/\.(jpe?g|png)$/i.test(suffix)) return;
    const folderName = segments.slice(0, tileIndex).at(-1) || 'panorama';
    map[suffix] = `./tiles/${folderName}/${suffix}`;
  });

  exportTargets.forEach((item) => {
    const root = item.root || `./tiles/${item.key}`;
    if (item.key) {
      map[`${item.key}/preview.jpg`] = `${root}/preview.jpg`;
    }
  });

  return map;
}

export async function addBundledMarzipanoTemplate(zip) {
  const templateFiles = [
    'LICENSE.txt',
    'README.txt',
    'app-files/img/close.png',
    'app-files/img/collapse.png',
    'app-files/img/down.png',
    'app-files/img/expand.png',
    'app-files/img/fullscreen.png',
    'app-files/img/info.png',
    'app-files/img/left.png',
    'app-files/img/link.png',
    'app-files/img/minus.png',
    'app-files/img/pause.png',
    'app-files/img/play.png',
    'app-files/img/plus.png',
    'app-files/img/right.png',
    'app-files/img/up.png',
    'app-files/img/windowed.png',
    'app-files/vendor/bowser.min.js',
    'app-files/vendor/marzipano.js',
    'app-files/vendor/reset.min.css',
    'app-files/vendor/screenfull.min.js',
    'app-files/index.js',
    'app-files/style.css'
  ];

  await Promise.all(templateFiles.map(async (path) => {
    const response = await fetch(`/marzipano-template/${path}`);
    if (response.ok) zip.file(path, await response.arrayBuffer());
  }));
}
