import * as THREE from 'three';
import Marzipano from 'marzipano';
import JSZip from 'jszip';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import './style.css';
import { removeHotspotFromMap } from './hotspot-utils.js';
import { createSceneController, resizeScene, frameModel, disposeModel } from './scene.js';
import {
  readFileAsDataUrl,
  splitCubePreviewFaces,
  buildMarzipanoDataJs,
  buildExportChatScript,
  buildExportHtml,
  buildStandaloneMarzipanoIndexHtml,
  buildMarzipanoIndexHtml,
  buildTemplatePreviewScript,
  buildPreviewAssetMap,
  buildExportTileUrlMap,
  addBundledMarzipanoTemplate,
  generateOfficialEquirectTiles
} from './export.js';

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div class="top-actions">
        <label class="header-action" id="header-file-trigger">
          <input id="file-input" type="file" accept=".zip" />
          <span>Open project</span>
        </label>
        <button id="new-project-btn" class="badge" type="button">New project</button>
        <button id="add-hotspot-btn" class="badge hotspot-btn" style="display: none;">+ Hotspot</button>
        <button id="project-details-btn" class="badge" type="button">Project details</button>
        <button id="export-btn" class="badge export-btn" style="cursor: pointer; display: none;">Export</button>
        <button id="preview-btn" class="badge preview-btn" style="display: none;">Preview</button>
      </div>
      <div class="brand"><div class="brand-mark">K</div><div class="brand-name">Kaashi <span>/ studio</span></div></div>
    </header>
    <section class="workspace">
      <aside class="sidebar">
        <p class="eyebrow">3D asset viewer</p>
        <h1 class="sidebar-title">Scene workspace</h1>
        <label class="sidebar-add-btn" id="sidebar-add-scene-trigger">
          <input id="sidebar-add-scene-input" type="file" accept=".glb,.gltf,.obj,.fbx,.jpg,.jpeg,.png" multiple />
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          Add scene
        </label>
        <section class="file-list"><div class="section-label"><span>Scene files</span><span class="file-count" id="file-count">00</span></div><div class="files" id="files"><div class="empty-files">No files added yet</div></div></section>
      </aside>
      <div class="viewer">
        <div id="scene"></div>
        <div id="panorama"></div>
        <div class="viewer-header"><div class="viewer-title"><h2 id="scene-name">Studio preview</h2><p id="scene-meta">DEFAULT SCENE / 01</p></div><span class="badge">ORBIT VIEW</span></div>
        <div class="hint">Drag to rotate <span>·</span> Scroll to zoom</div>
        <div class="status" id="status"></div>
      </div>
    </section>
    <footer class="footer"><span>KAASHI / 2026</span><span>LOCAL PREVIEW · NO UPLOAD</span></footer>
  </main>`;

const sceneHost = document.querySelector('#scene');
const panoramaHost = document.querySelector('#panorama');
const status = document.querySelector('#status');
const { scene, camera, renderer, controls, defaultModel, floor, grid, core, ring, ring2 } = createSceneController(sceneHost);

let activeModel;
activeModel = defaultModel;

function resize() {
  resizeScene(sceneHost, camera, renderer);
}
window.addEventListener('resize', resize);
resize();

function clearModel() {
  panoramaHost.innerHTML = '';
  renderer.domElement.style.display = '';
  if (!activeModel || activeModel === defaultModel) return;
  scene.remove(activeModel);
  disposeModel(activeModel);
}

function showProgress(label, value) {
  const safeValue = Math.min(100, Math.max(0, value));
  status.innerHTML = `
    <div class="panorama-progress">
      <div class="panorama-progress-label">${label}</div>
      <div class="panorama-progress-track">
        <div class="panorama-progress-fill" style="width: ${safeValue}%"></div>
      </div>
    </div>
  `;
}

function nextPowerOfTwo(value) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

function isPreviewFile(file) {
  const name = file?.name || '';
  const relative = normalizeRelativePath(file?.webkitRelativePath || file?.relativePath || '');
  return /preview\.(jpe?g|png)$/i.test(name) || /\/preview\.(jpe?g|png)$/i.test(relative);
}

function normalizeRelativePath(value) {
  return (value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

async function blobUrlFromZipEntry(zip, entryPath) {
  const entry = zip.files[entryPath];
  if (!entry || entry.dir) return '';
  const data = await entry.async('uint8array');
  const blob = new Blob([data]);
  return URL.createObjectURL(blob);
}

async function dataUrlFromZipEntry(zip, entryPath) {
  const entry = zip.files[entryPath];
  if (!entry || entry.dir) return '';
  const data = await entry.async('uint8array');
  let binary = '';
  data.forEach((byte) => { binary += String.fromCharCode(byte); });
  const mime = /\.png$/i.test(entryPath) ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${btoa(binary)}`;
}

function isMarzipanoTileLevelSegment(segment) {
  if (!segment) return false;
  if (/^preview\.(jpe?g|png)$/i.test(segment)) return true;
  return /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment);
}

function getMarzipanoRootPath(file) {
  const relative = normalizeRelativePath(file?.webkitRelativePath || file?.relativePath || '');
  if (!relative) return null;

  const segments = relative.split('/').filter(Boolean);
  const levelIndex = segments.findIndex((segment) => isMarzipanoTileLevelSegment(segment));
  if (levelIndex <= 0) return null;
  return `/${segments.slice(0, levelIndex).join('/')}`;
}

function getMarzipanoTileFolder(file) {
  const relative = normalizeRelativePath(file?.webkitRelativePath || file?.relativePath || '');
  if (relative) {
    const segments = relative.split('/').filter(Boolean);
    const levelIndex = segments.findIndex((segment) => isMarzipanoTileLevelSegment(segment));
    if (levelIndex > 0) {
      const folder = segments[levelIndex - 1];
      if (folder && !['tiles', 'tile', 'pic', 'app-files', 'files'].includes(folder.toLowerCase())) {
        return folder.replace(/\.[^/.]+$/, '');
      }
    }
    if (segments.length > 0) {
      return segments[segments.length - 1].replace(/\.[^/.]+$/, '') || segments[0];
    }
  }

  const name = (file?.name || '').replace(/\.[^/.]+$/, '');
  if (name) return name;
  return '0-test';
}

async function resolveLocalMarzipanoTiles(file) {
  const relative = normalizeRelativePath(file?.webkitRelativePath || file?.relativePath || '');
  if (relative && relative.includes('/')) {
    return null;
  }

  const rootPath = getMarzipanoRootPath(file);
  if (rootPath) {
    try {
      const previewUrl = `${rootPath}/preview.jpg`;
      const response = await fetch(previewUrl, { method: 'HEAD' });
      if (response.ok) {
        return rootPath;
      }
    } catch {
      // Continue to fallback checks.
    }
  }

  const folderName = getMarzipanoTileFolder(file);
  const candidates = [
    `/pic/tiles/${folderName}`,
    `/pic/tiles00/${folderName}`,
    `/pic/${folderName}`,
    `/${folderName}`,
    '/pic/tiles'
  ];

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  for (const candidate of uniqueCandidates) {
    try {
      const response = await fetch(`${candidate.replace(/\/$/, '')}/preview.jpg`, { method: 'HEAD' });
      if (response.ok) {
        return candidate.replace(/\/$/, '');
      }
    } catch {
      // Try the next possible tile root.
    }
  }

  return null;
}

function addZipSceneItems(file, targets) {
  const list = document.querySelector('#files');
  targets.forEach((target, index) => {
    if (isZipSceneDeleted(file, target.key)) return;
    const itemKey = `${file.name}:${target.key}`;
    if ([...list.querySelectorAll('.file-name')].some((element) => element.dataset.fileName === itemKey)) return;

    const item = document.createElement('div');
    item.className = 'file-item';
    item.draggable = true;
    item.innerHTML = `<span class="file-type">PANO</span><span class="file-name" data-file-name="${itemKey}" title="${target.label}"><input class="scene-title-input" type="text" value="" aria-label="Scene title"><small class="file-size">ZIP scene ${index + 1}</small></span><button type="button" class="scene-properties-btn" aria-label="Scene properties">Properties</button><button type="button" class="scene-delete-btn" aria-label="Delete scene">Delete</button>`;
    const titleInput = item.querySelector('.scene-title-input');
    titleInput.value = getSceneTitle(target.key, target.label);
    titleInput.addEventListener('click', (event) => event.stopPropagation());
    titleInput.addEventListener('input', () => {
      const title = titleInput.value.trim() || target.label;
      sceneTitles.set(target.key, title);
      titleInput.title = title;
    });
    item.querySelector('.scene-properties-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      [...list.children].forEach((child) => child.classList.remove('is-active'));
      item.classList.add('is-active');
      if (isCurrentZipScene(file, target.key)) {
        editSceneProperties(target.key);
        return;
      }
      loadMarzipanoExportZip(file, index, target.key).then(() => editSceneProperties(target.key));
    });
    item.querySelector('.scene-delete-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      removeSceneItem(item, file, target.key, true);
    });
    list.appendChild(item);
    enableFileItemDrag(item, list);
    item.addEventListener('click', () => {
      if (item.dataset.dragged === 'true') {
        item.dataset.dragged = 'false';
        return;
      }
      [...list.children].forEach((child) => child.classList.remove('is-active'));
      item.classList.add('is-active');
      if (!isCurrentZipScene(file, target.key)) loadMarzipanoExportZip(file, index, target.key);
    });
  });
  document.querySelector('#file-count').textContent = String(list.children.length).padStart(2, '0');
}

function enableFileItemDrag(item, list) {
  item.addEventListener('dragstart', (event) => {
    list._draggedItem = item;
    item.dataset.dragged = 'false';
    item.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'file-item');
  });
  item.addEventListener('dragover', (event) => {
    event.preventDefault();
    const draggedItem = list._draggedItem;
    if (!draggedItem || draggedItem === item) return;
    const box = item.getBoundingClientRect();
    const insertBefore = event.clientY < box.top + box.height / 2;
    list.insertBefore(draggedItem, insertBefore ? item : item.nextSibling);
    draggedItem.dataset.dragged = 'true';
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('is-dragging');
    list._draggedItem = null;
  });
}

async function loadMarzipanoExportZip(file, targetIndex = 0, targetKey = null) {
  try {
    renderer.domElement.style.display = 'none';
    scene.remove(defaultModel, floor, grid);
    activeModel = undefined;
    const previousZipFile = currentFileType === 'zip' ? currentFile : null;
    currentFile = file;
    currentFileType = 'zip';
    currentMarzipanoFiles = [];
    panoramaHost.innerHTML = '';
    if (panoramaViewer) {
      try {
        panoramaViewer.destroy();
      } catch (err) {
        console.warn('Previous panorama destroy failed', err);
      }
      panoramaViewer = null;
      activePanoramaViewListener = null;
    }

    showProgress('Loading Marzipano export...', 15);
    const zip = await JSZip.loadAsync(file);
    const isNewZip = previousZipFile !== file;
    currentZipArchive = zip;
    const zipFiles = new Map();
    Object.keys(zip.files).forEach((path) => {
      if (zip.files[path].dir) return;
      const normalized = normalizeRelativePath(path);
      zipFiles.set(normalized, zip.files[path]);
    });
    const linkIconPath = [...zipFiles.keys()].find((path) => /(^|\/)img\/link\.png$/i.test(path));
    currentZipLinkIconUrl = linkIconPath ? await blobUrlFromZipEntry(zip, linkIconPath) : '';

    const manifestPath = [...zipFiles.keys()].find((path) => path.endsWith('panorama-data.json')) || [...zipFiles.keys()].find((path) => path.endsWith('data.json'));
    const appDataPath = [...zipFiles.keys()].find((path) => path.endsWith('data.js'));
    let exportTargets = [];
    if (manifestPath) {
      const manifestText = await zipFiles.get(manifestPath).async('string');
      exportTargets = JSON.parse(manifestText || '[]');
      projectBuildingDetails = exportTargets[0]?.projectDetails || {};
    }
    if (!exportTargets.length && appDataPath) {
      const appDataText = await zipFiles.get(appDataPath).async('string');
      const appDataStart = appDataText.indexOf('{');
      const appDataEnd = appDataText.lastIndexOf('}');
      if (appDataStart >= 0 && appDataEnd > appDataStart) {
        const appData = JSON.parse(appDataText.slice(appDataStart, appDataEnd + 1));
        projectBuildingDetails = appData.projectDetails || {};
        const appRoot = appDataPath.slice(0, appDataPath.lastIndexOf('/') + 1);
        const sceneNames = new Map((appData.scenes || []).map((scene) => [scene.id, scene.name || scene.id]));
        exportTargets = (appData.scenes || []).map((scene) => ({
          key: scene.id,
          label: scene.name || scene.id,
          root: `${appRoot}tiles/${scene.id}`,
          previewUrl: `${appRoot}tiles/${scene.id}/preview.jpg`,
          geometryType: 'cube',
          yaw: Number(scene.initialViewParameters?.yaw || 0),
          pitch: Number(scene.initialViewParameters?.pitch || 0),
          fov: Number(scene.initialViewParameters?.fov || Math.PI / 2),
          sceneSound: scene.sceneSound || scene.pageSound || scene.ambientSound || scene.sound || null,
          sceneVideo: scene.sceneVideo || scene.avatarVideo || scene.video || null,
          hotspots: (scene.linkHotspots || []).map((hotspot) => ({
            label: hotspot.text || sceneNames.get(hotspot.target) || 'Hotspot',
            yaw: Number(hotspot.yaw || 0),
            pitch: Number(hotspot.pitch || 0),
            target: hotspot.target,
            targetViewParameters: hotspot.targetViewParameters || {
              yaw: Number(hotspot.targetYaw || 0),
              pitch: Number(hotspot.targetPitch || 0),
              fov: Number(hotspot.targetFov ?? 120)
            },
            targetYaw: Number(hotspot.targetYaw ?? hotspot.targetViewParameters?.yaw ?? 0),
            targetPitch: Number(hotspot.targetPitch ?? hotspot.targetViewParameters?.pitch ?? 0),
            targetFov: Number(hotspot.targetFov ?? hotspot.targetViewParameters?.fov ?? 120),
            sizePercent: Math.min(200, Math.max(50, Number(hotspot.sizePercent) || 100)),
            rotation: Number(hotspot.rotation || 0),
            sound: hotspot.sound || null
          }))
        }));
        await Promise.all(exportTargets.flatMap((target) => (target.hotspots || []).map(async (hotspot) => {
          const soundPath = hotspot.sound?.path || hotspot.sound?.url;
          if (!soundPath || soundPath.startsWith('data:')) return;
          const normalizedPath = normalizeRelativePath(soundPath).replace(/^\.\//, '');
          const candidates = [normalizedPath, `${appRoot}${normalizedPath}`, normalizedPath.replace(/^app-files\//, '')];
          const entryPath = candidates.find((candidate) => zipFiles.has(candidate));
          if (!entryPath) return;
          hotspot.sound = {
            path: entryPath.startsWith(`${appRoot}`) ? entryPath.slice(appRoot.length) : entryPath,
            url: await blobUrlFromZipEntry(zip, entryPath),
            name: hotspot.sound.name || entryPath.split('/').pop(),
            loop: Boolean(hotspot.sound.loop)
          };
        })));
        await Promise.all(exportTargets.map(async (target) => {
          const sound = target.sceneSound;
          const soundPath = sound?.path || sound?.url;
          if (!soundPath || soundPath.startsWith('data:')) return;
          const normalizedPath = normalizeRelativePath(soundPath).replace(/^\.\//, '');
          const candidates = [normalizedPath, `${appRoot}${normalizedPath}`, normalizedPath.replace(/^app-files\//, '')];
          const entryPath = candidates.find((candidate) => zipFiles.has(candidate));
          if (!entryPath) return;
          target.sceneSound = {
            path: entryPath.startsWith(`${appRoot}`) ? entryPath.slice(appRoot.length) : entryPath,
            url: await blobUrlFromZipEntry(zip, entryPath),
            name: sound.name || entryPath.split('/').pop(),
            loop: Boolean(sound.loop)
          };
        }));
        await Promise.all(exportTargets.map(async (target) => {
          const video = target.sceneVideo;
          const videoPath = video?.path || video?.url;
          if (!videoPath || videoPath.startsWith('data:')) return;
          const normalizedPath = normalizeRelativePath(videoPath).replace(/^\.\//, '');
          const candidates = [normalizedPath, `${appRoot}${normalizedPath}`, normalizedPath.replace(/^app-files\//, '')];
          const entryPath = candidates.find((candidate) => zipFiles.has(candidate));
          if (!entryPath) return;
          target.sceneVideo = { path: entryPath.startsWith(`${appRoot}`) ? entryPath.slice(appRoot.length) : entryPath, url: await blobUrlFromZipEntry(zip, entryPath), name: video.name || entryPath.split('/').pop() };
        }));
      }
    }
    if (!manifestPath) {
      const imageEntries = [...zipFiles.entries()].filter(([path]) => {
        const segments = path.split('/').filter(Boolean);
        return segments.length === 1 && /\.(jpe?g|png)$/i.test(path);
      });
      const extractedImages = await Promise.all(imageEntries.map(async ([path, entry]) => {
        const blob = await entry.async('blob');
        return new File([blob], path.split('/').pop(), { type: blob.type || 'image/jpeg' });
      }));

      if (extractedImages.length) {
        addFiles(extractedImages, { autoLoad: false });
        await loadPanorama(extractedImages[0]);
        return;
      }
    }

    exportTargets = exportTargets.filter((target) => !isZipSceneDeleted(file, target.key));
    currentZipExportTargets = exportTargets;
    exportTargets.forEach((target) => {
      if (!sceneVideos.has(target.key) && target.sceneVideo) sceneVideos.set(target.key, target.sceneVideo);
    });
    if (isNewZip) {
      sceneViewSettings.clear();
      exportTargets.forEach((target) => {
        sceneViewSettings.set(target.key, { yaw: Number(target.yaw || 0), pitch: Number(target.pitch || 0) });
        sceneSounds.set(target.key, target.sceneSound || null);
        sceneVideos.set(target.key, target.sceneVideo || null);
      });
    }

    const keyedTarget = targetKey ? exportTargets.find((target) => target.key === targetKey) : null;
    const firstTarget = keyedTarget || (Array.isArray(exportTargets) && exportTargets.length ? exportTargets[Math.min(targetIndex, exportTargets.length - 1)] : { key: 'marzipano-export', label: file.name.replace(/\.[^/.]+$/, ''), root: './tiles/marzipano-export', previewUrl: './tiles/marzipano-export/preview.jpg', geometryType: 'cube', yaw: 0, pitch: 0, fov: Math.PI / 2, hotspots: [] });
    if (exportTargets.length) addZipSceneItems(file, exportTargets);
    currentZipSceneKey = firstTarget.key;
    const panoramaKey = String(firstTarget.key || file.name.replace(/\.[^/.]+$/, '') || 'marzipano-export');
    const tileRoot = normalizeRelativePath(firstTarget.root || `./tiles/${panoramaKey}`).replace(/^\.\//, '').replace(/\/$/, '');

    const previewEntry = [...zipFiles.keys()].find((path) => /(^|\/)preview\.(jpe?g|png)$/i.test(path)) || [...zipFiles.keys()].find((path) => /\.(jpe?g|png)$/i.test(path));
    const previewUrl = previewEntry ? await blobUrlFromZipEntry(zip, previewEntry) : '';

    const tileUrlMapReady = await Promise.all([...zipFiles.keys()].filter((path) => /\.(jpe?g|png)$/i.test(path)).map(async (path) => [path, await blobUrlFromZipEntry(zip, path)]));
    const resolvedTileMap = new Map(tileUrlMapReady);
    currentZipPreviewTileMap = {};
    currentZipPreviewUrls = new Map();
    resolvedTileMap.forEach((url, path) => {
      const tileMarker = '/tiles/';
      const tileIndex = path.indexOf(tileMarker);
      if (tileIndex < 0) return;
      const relative = path.slice(tileIndex + tileMarker.length);
      const parts = relative.split('/');
      if (parts.length < 2) return;
      currentZipPreviewTileMap[relative] = url;
    });
    await Promise.all(exportTargets.map(async (target) => {
      const previewPath = [...resolvedTileMap.keys()].find((path) => path.endsWith(`/tiles/${target.key}/preview.jpg`));
      if (previewPath) currentZipPreviewUrls.set(target.key, await dataUrlFromZipEntry(zip, previewPath));
    }));

    const tileLevels = [
      { tileSize: 256, size: 256, fallbackOnly: true },
      { tileSize: 512, size: 512 },
      { tileSize: 512, size: 1024 },
      { tileSize: 512, size: 2048 }
    ];

    if (isNewZip) {
      panoramaHotspots.clear();
      exportTargets.forEach((target) => {
        panoramaHotspots.set(target.key, (target.hotspots || []).map((hotspot) => ({
          id: Date.now() + Math.random(),
          label: hotspot.label || 'Hotspot',
          yaw: Number(hotspot.yaw || 0),
          pitch: Number(hotspot.pitch || 0),
          target: hotspot.target,
          targetViewParameters: hotspot.targetViewParameters || {
            yaw: Number(hotspot.targetYaw || 0),
            pitch: Number(hotspot.targetPitch || 0),
            fov: Number(hotspot.targetFov ?? 120)
          },
          sizePercent: Math.min(200, Math.max(50, Number(hotspot.sizePercent) || 100)),
          rotation: Number(hotspot.rotation || 0),
          sound: hotspot.sound || null
        })));
      });
    }

    const source = new Marzipano.ImageUrlSource((tile) => {
      const candidates = [
        `${tileRoot}/${tile.z}/${tile.face}/${tile.y}/${tile.x}.jpg`,
        `${tileRoot}/${tile.z}/${tile.face}/${tile.y}/${tile.x}.png`,
        `${tileRoot}/${tile.z}/${tile.face}/${tile.y}/${tile.x}.jpeg`
      ];
      const resolved = candidates.find((candidate) => resolvedTileMap.has(candidate));
      if (resolved) return { url: resolvedTileMap.get(resolved) || previewUrl || URL.createObjectURL(file) };
      return { url: previewUrl || URL.createObjectURL(file) };
    });

    const initialView = sceneViewSettings.get(panoramaKey) || { yaw: Number(firstTarget.yaw || 0), pitch: Number(firstTarget.pitch || 0) };
    const view = new Marzipano.RectilinearView({ yaw: initialView.yaw, pitch: initialView.pitch, fov: 100 * Math.PI / 180 }, Marzipano.RectilinearView.limit.traditional(2048, 120 * Math.PI / 180));
    panoramaViewer = new Marzipano.Viewer(panoramaHost, { stage: { progressive: true } });
    const panoramaScene = panoramaViewer.createScene({ source, geometry: new Marzipano.CubeGeometry(tileLevels), view, pinFirstLevel: true });
    activePanoramaScene = panoramaScene;
    if (activePanoramaViewListener) {
      view.removeEventListener('change', activePanoramaViewListener);
    }
    activePanoramaViewListener = () => {
      currentPanoramaViewState = getViewAngles(view);
      sceneViewSettings.set(panoramaKey, currentPanoramaViewState);
    };
    view.addEventListener('change', activePanoramaViewListener);
    currentPanoramaViewState = getViewAngles(view);
    panoramaScene.switchTo();
    renderHotspotsForCurrentPanorama();

    document.querySelector('#scene-name').textContent = getSceneTitle(firstTarget.key, firstTarget.label || file.name.replace(/\.[^/.]+$/, ''));
    document.querySelector('#scene-meta').textContent = 'PANORAMA / MARZIPANO ZIP';
    document.querySelector('#export-btn').style.display = 'inline-block';
    document.querySelector('#preview-btn').style.display = 'inline-block';
    document.querySelector('#add-hotspot-btn').style.display = 'inline-block';
    status.textContent = '';
    showProgress('Ready', 100);
    setTimeout(() => { status.textContent = ''; }, 500);
  } catch (err) {
    console.error('Marzipano ZIP load failed', err);
    renderer.domElement.style.display = '';
    status.textContent = 'Failed to load ZIP file';
    setTimeout(() => { status.textContent = ''; }, 2600);
  }
}

async function loadPanorama(file) {
  try {
    renderer.domElement.style.display = 'none';
    scene.remove(defaultModel, floor, grid);
    activeModel = undefined;
    currentFile = file;
    currentZipSceneKey = null;
    currentFileType = file.name.split('.').pop().toLowerCase();
    currentMarzipanoFiles = panoramaFileGroups.get(getMarzipanoTileFolder(file)) || [];
    document.querySelector('#export-btn').style.display = 'inline-block';
    document.querySelector('#preview-btn').style.display = 'inline-block';
    document.querySelector('#add-hotspot-btn').style.display = 'inline-block';

    panoramaHost.innerHTML = '';
    if (panoramaViewer) {
      try {
        panoramaViewer.destroy();
      } catch (err) {
        console.warn('Previous panorama destroy failed', err);
      }
      panoramaViewer = null;
      activePanoramaViewListener = null;
    }

    showProgress('Loading panorama...', 20);

    const localRoot = currentMarzipanoFiles.length || isMarzipanoTileSelection(file)
      ? await resolveLocalMarzipanoTiles(file)
      : null;
    const isRawEquirect = !localRoot && !currentMarzipanoFiles.length && /\.jpe?g$/i.test(file.name);
    let generatedEquirect = officialEquirectResults.get(file) || null;
    if (isRawEquirect && !generatedEquirect) {
      showProgress('Processing panorama... 0%', 20);
      generatedEquirect = await generateOfficialEquirectTiles(file, {
        onProgress: (pct) => showProgress(`Processing panorama... ${pct}%`, pct),
      });
      officialEquirectResults.set(file, generatedEquirect);
    }
    // Track this file so all equirect scenes (not just currentFile) can be exported.
    if (isRawEquirect) {
      const sceneKey = getMarzipanoTileFolder(file) || file.name.replace(/\.[^/.]+$/, '');
      equirectSourceFiles.set(sceneKey, file);
      // Also store under the full filename (used as displayName / sceneKey in the sidebar)
      if (file.name !== sceneKey) equirectSourceFiles.set(file.name, file);
    }
    if (generatedEquirect) showProgress('Loading tiled panorama...', 90);
    const tileLevels = [
      { tileSize: 256, size: 256, fallbackOnly: true },
      { tileSize: 512, size: 512 },
      { tileSize: 512, size: 1024 },
      { tileSize: 512, size: 2048 }
    ];

    const uploadedTiles = currentMarzipanoFiles.length ? currentMarzipanoFiles : [];
    const uploadedPreview = uploadedTiles.find((candidate) => /preview\.(jpe?g|png)$/i.test(candidate.name) || /\/preview\.(jpe?g|png)$/i.test(normalizeRelativePath(candidate.webkitRelativePath || candidate.relativePath || '')));
    const uploadedTileMap = new Map();
    uploadedTiles.forEach((tileFile) => {
      const relative = normalizeRelativePath(tileFile.webkitRelativePath || tileFile.relativePath || tileFile.name);
      const segments = relative.split('/').filter(Boolean);
      const tileIndex = segments.findIndex((segment) => /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment));
      if (tileIndex <= 0) return;
      const suffix = segments.slice(tileIndex).join('/');
      if (suffix && /\.(jpe?g|png)$/i.test(suffix)) {
        uploadedTileMap.set(suffix, tileFile);
      }
    });

    const usesUploadedFiles = currentMarzipanoFiles.length > 0;
    const officialSource = generatedEquirect ? createOfficialEquirectSource(generatedEquirect) : null;
    const source = officialSource?.source || (usesUploadedFiles
      ? new Marzipano.ImageUrlSource((tile) => {
          const candidates = [
            `${tile.z}/${tile.face}/${tile.y}/${tile.x}.jpg`,
            `${tile.z}/${tile.face}/${tile.y}/${tile.x}.png`,
            `${tile.z}/${tile.face}/${tile.y}/${tile.x}.jpeg`
          ];
          const tileFile = candidates.map((key) => uploadedTileMap.get(key)).find(Boolean);
          if (tileFile) return { url: URL.createObjectURL(tileFile) };
          if (uploadedPreview) return { url: URL.createObjectURL(uploadedPreview) };
          return { url: URL.createObjectURL(file) };
        })
      : localRoot
        ? Marzipano.ImageUrlSource.fromString(`${localRoot}/{z}/{f}/{y}/{x}.jpg`, {
            cubeMapPreviewUrl: `${localRoot}/preview.jpg`,
            cubeMapPreviewFaceOrder: 'bdflru'
          })
        : new Marzipano.ImageUrlSource(() => ({ url: URL.createObjectURL(file) })));

    const geometry = officialSource?.geometry || (usesUploadedFiles || localRoot
      ? new Marzipano.CubeGeometry(tileLevels)
      : new Marzipano.EquirectGeometry([
          { tileSize: 1024, size: 1024 },
          { tileSize: 1024, size: 2048 }
        ]));

    const panoramaKey = getMarzipanoTileFolder(file) || file.name;
    const initialView = sceneViewSettings.get(panoramaKey) || { yaw: 0, pitch: 0 };
    const view = new Marzipano.RectilinearView({ yaw: initialView.yaw, pitch: initialView.pitch, fov: 100 * Math.PI / 180 }, Marzipano.RectilinearView.limit.traditional(2048, 120 * Math.PI / 180));
    panoramaViewer = new Marzipano.Viewer(panoramaHost, { stage: { progressive: true } });
    const panoramaScene = panoramaViewer.createScene({ source, geometry, view, pinFirstLevel: true });
    activePanoramaScene = panoramaScene;
    if (activePanoramaViewListener) {
      view.removeEventListener('change', activePanoramaViewListener);
    }
    activePanoramaViewListener = () => {
      currentPanoramaViewState = getViewAngles(view);
      sceneViewSettings.set(panoramaKey, currentPanoramaViewState);
    };
    view.addEventListener('change', activePanoramaViewListener);
    currentPanoramaViewState = getViewAngles(view);
    panoramaScene.switchTo();
    renderHotspotsForCurrentPanorama();

    const displayName = (usesUploadedFiles || localRoot) ? getMarzipanoTileFolder(file) || file.name : file.name;
    document.querySelector('#scene-name').textContent = getSceneTitle(getMarzipanoTileFolder(file), displayName);
    document.querySelector('#scene-meta').textContent = generatedEquirect
      ? 'PANORAMA / MARZIPANO TILES'
      : (usesUploadedFiles || localRoot) ? 'PANORAMA / LOCAL TILES' : 'PANORAMA / EQUIRECTANGULAR';
    status.textContent = '';
    showProgress('Ready', 100);
    setTimeout(() => { status.textContent = ''; }, 500);
  } catch (err) {
    console.error('Panorama load failed', err);
    renderer.domElement.style.display = '';
    status.textContent = 'Failed to load image';
    setTimeout(() => { status.textContent = ''; }, 2600);
  }
}

function loadFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);
  status.textContent = 'Loading...';
  clearModel();
  if (extension === 'zip') {
    loadMarzipanoExportZip(file);
    return;
  }
  if (extension === 'jpg' || extension === 'jpeg' || extension === 'png') {
    loadPanorama(file);
    return;
  }
  const finish = (model) => {
    activeModel = model.scene || model;
    activeModel.traverse((child) => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
    scene.remove(defaultModel);
    scene.add(floor, grid);
    panoramaHost.innerHTML = '';
    scene.add(activeModel);
    frameModel(activeModel, camera, controls);
    camera.fov = 38;
    camera.updateProjectionMatrix();
    controls.enablePan = true;
    currentFile = file;
    currentFileType = extension;
    document.querySelector('#export-btn').style.display = 'inline-block';
    document.querySelector('#preview-btn').style.display = 'inline-block';
    document.querySelector('#add-hotspot-btn').style.display = 'none';
    document.querySelector('#scene-name').textContent = file.name;
    document.querySelector('#scene-meta').textContent = `${extension.toUpperCase()} / LOCAL ASSET`;
    status.textContent = '';
    URL.revokeObjectURL(url);
  };
  const fail = () => { status.textContent = 'Failed to load file'; setTimeout(() => { status.textContent = ''; }, 2600); };
  if (extension === 'glb' || extension === 'gltf') new GLTFLoader().load(url, finish, undefined, fail);
  else if (extension === 'obj') new OBJLoader().load(url, finish, undefined, fail);
  else if (extension === 'fbx') new FBXLoader().load(url, finish, undefined, fail);
}

function isMarzipanoTileSelection(file) {
  const relative = normalizeRelativePath(file?.webkitRelativePath || file?.relativePath || '');
  if (!relative) return false;
  const segments = relative.split('/').filter(Boolean);
  if (segments.length < 2) return false;
  const hasLevel = segments.some((segment) => isMarzipanoTileLevelSegment(segment));
  if (!hasLevel) return false;
  const folderIndex = segments.findIndex((segment) => isMarzipanoTileLevelSegment(segment));
  return folderIndex > 0 && !['tiles', 'tile', 'pic', 'app-files', 'files'].includes(segments[folderIndex - 1].toLowerCase());
}

function addFiles(fileList, { autoLoad = true } = {}) {
  const files = [...fileList].filter((file) => /\.(glb|gltf|obj|fbx|jpg|jpeg|png|zip)$/i.test(file.name));
  if (!files.length) return;
  const displayFiles = files.filter((file) => !/\.zip$/i.test(file.name));

  if (currentZipArchive) {
    displayFiles.filter((file) => /\.(jpg|jpeg|png)$/i.test(file.name) && !isMarzipanoTileSelection(file)).forEach((file) => {
      if (!panoramaFileGroups.has(file.name)) panoramaFileGroups.set(file.name, [file]);
    });
  }

  const list = document.querySelector('#files');
  const existingNames = new Set([...list.querySelectorAll('.file-name')].map((item) => item.dataset.fileName));

  const marzipanoFiles = files.filter(isMarzipanoTileSelection);
  marzipanoFiles.forEach((file) => {
    const folderName = getMarzipanoTileFolder(file);
    if (!panoramaFileGroups.has(folderName)) panoramaFileGroups.set(folderName, []);
    const folderFiles = panoramaFileGroups.get(folderName);
    const isDuplicate = folderFiles.some((existingFile) => existingFile.name === file.name && (existingFile.webkitRelativePath || existingFile.relativePath || '') === (file.webkitRelativePath || file.relativePath || ''));
    if (!isDuplicate) {
      folderFiles.push(file);
    }
  });

  const grouped = new Map();
  const seenKeys = new Set();
  displayFiles.forEach((file) => {
    const key = isMarzipanoTileSelection(file) ? getMarzipanoTileFolder(file) : file.name;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, file);
      return;
    }
    if (isPreviewFile(file) && !isPreviewFile(current)) {
      return;
    }
    if (!isPreviewFile(file) && isPreviewFile(current)) {
      grouped.set(key, file);
    }
  });

  const uniqueFiles = [...grouped.values()].filter((file) => {
    const displayName = isMarzipanoTileSelection(file) ? getMarzipanoTileFolder(file) : file.name;
    return !existingNames.has(displayName);
  });

  uniqueFiles.forEach((file) => {
    const displayName = isMarzipanoTileSelection(file) ? getMarzipanoTileFolder(file) : file.name;
    if (existingNames.has(displayName)) return;

    const item = document.createElement('div');
    item.className = 'file-item';
    item.draggable = true;
    item.innerHTML = `<span class="file-type">${displayName.split('.').pop().toUpperCase()}</span><span class="file-name" data-file-name="${displayName}" title="${displayName}"><input class="scene-title-input" type="text" value="" aria-label="Scene title"><small class="file-size">${(file.size / 1024 / 1024).toFixed(2)} MB</small></span><button type="button" class="scene-properties-btn" aria-label="Scene properties">Properties</button><button type="button" class="scene-delete-btn" aria-label="Delete file">Delete</button>`;
    const titleInput = item.querySelector('.scene-title-input');
    titleInput.value = getSceneTitle(displayName, displayName);
    titleInput.addEventListener('click', (event) => event.stopPropagation());
    titleInput.addEventListener('input', () => {
      const title = titleInput.value.trim() || displayName;
      sceneTitles.set(displayName, title);
      titleInput.title = title;
    });
    item.querySelector('.scene-properties-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      [...list.children].forEach((child) => child.classList.remove('is-active'));
      item.classList.add('is-active');
      if (isCurrentPanorama(file, displayName)) {
        editSceneProperties(displayName);
        return;
      }
      loadPanorama(file).then(() => editSceneProperties(displayName));
    });
    item.querySelector('.scene-delete-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      removeSceneItem(item, file, displayName, false);
    });
    list.appendChild(item);
    enableFileItemDrag(item, list);
    item.addEventListener('click', () => {
      if (item.dataset.dragged === 'true') {
        item.dataset.dragged = 'false';
        return;
      }
      [...list.children].forEach((child) => child.classList.remove('is-active'));
      item.classList.add('is-active');
      if (!isCurrentPanorama(file, displayName)) loadFile(file);
    });
  });

  const firstNewFile = uniqueFiles.find((file) => {
    const displayName = isMarzipanoTileSelection(file) ? getMarzipanoTileFolder(file) : file.name;
    return !existingNames.has(displayName);
  });

  if (firstNewFile && autoLoad) {
    const displayName = isMarzipanoTileSelection(firstNewFile) ? getMarzipanoTileFolder(firstNewFile) : firstNewFile.name;
    const firstItem = [...list.children].find((item) => item.querySelector('[data-file-name]')?.dataset.fileName === displayName);
    firstItem?.classList.add('is-active');
    loadFile(firstNewFile);
  }

  const zipFile = files.find((file) => /\.zip$/i.test(file.name));
  if (zipFile && autoLoad) loadFile(zipFile);

  document.querySelector('#file-count').textContent = String(list.children.length).padStart(2, '0');
}

let currentFile = null;
let currentFileType = null;
let currentMarzipanoFiles = [];
let panoramaViewer = null;
let activePanoramaScene = null;
let panoramaFileGroups = new Map();
let panoramaHotspots = new Map();
let sceneTitles = new Map();
// Maps scene key → original File object for plain equirectangular JPGs.
// Used at export time so all loaded scenes (not just currentFile) get tiled.
let equirectSourceFiles = new Map();
let currentZipSceneKey = null;
let currentZipLinkIconUrl = '';
let currentZipArchive = null;
const officialEquirectResults = new WeakMap();

function createOfficialEquirectSource(generated) {
  // Build a lookup by level SIZE (not index) so we can match what the worker produced.
  // Key format: "{levelSize}/{face}/{tileY}/{tileX}"
  const tileMap = new Map();
  generated.tiles.forEach((tile) => {
    const levelSize = tile.level?.size ?? tile.level;
    const key = `${levelSize}/${tile.face}/${tile.y}/${tile.x}`;
    tileMap.set(key, URL.createObjectURL(new Blob([tile.data], { type: 'image/jpeg' })));
  });

  // Build a level-index → level-size map so we can translate tile.z → size at request time.
  // The geometry levels array is: [fallback256, ...generated.levels]
  // index 0 = fallback (size 256), index 1 = first real level, etc.
  const geometryLevels = [
    { tileSize: 256, size: 256, fallbackOnly: true },
    ...generated.levels,
  ];
  // Map from index → size for quick lookup
  const indexToSize = geometryLevels.map((l) => l.size);

  const previewUrl = generated.preview
    ? URL.createObjectURL(new Blob([generated.preview], { type: 'image/jpeg' }))
    : '';

  return {
    source: new Marzipano.ImageUrlSource((tile) => {
      // tile.z is the level INDEX in the geometry levels array.
      const levelSize = indexToSize[Number(tile.z)] ?? null;

      // Level 0 is the fallback — serve from the preview strip using rect.
      if (Number(tile.z) === 0 && previewUrl) {
        const faceIndex = 'bdflru'.indexOf(String(tile.face || '').toLowerCase());
        if (faceIndex >= 0) {
          return { url: previewUrl, rect: { x: 0, y: faceIndex / 6, width: 1, height: 1 / 6 } };
        }
      }

      if (levelSize !== null) {
        const key = `${levelSize}/${tile.face}/${tile.y}/${tile.x}`;
        const url = tileMap.get(key);
        if (url) return { url };
      }

      // Final fallback: preview strip
      if (previewUrl) {
        const faceIndex = 'bdflru'.indexOf(String(tile.face || '').toLowerCase());
        if (faceIndex >= 0) {
          return { url: previewUrl, rect: { x: 0, y: faceIndex / 6, width: 1, height: 1 / 6 } };
        }
      }
      return { url: previewUrl || '' };
    }),
    geometry: new Marzipano.CubeGeometry(geometryLevels),
  };
}
let currentZipExportTargets = [];
let currentZipPreviewTileMap = {};
let currentZipPreviewUrls = new Map();
const deletedZipScenes = new WeakMap();
let sceneViewSettings = new Map();
// Stores initial view set explicitly by the user via Properties dialog.
// Unlike sceneViewSettings (which tracks current drag/scroll), this is only
// written when the user clicks OK in Properties — never overwritten by panning.
let sceneInitialViewSettings = new Map();
let sceneSounds = new Map();
let sceneVideos = new Map();
let projectBuildingDetails = {};
let hotspotPlacementMode = false;
let currentPanoramaViewState = { yaw: 0, pitch: 0 };
let activePanoramaViewListener = null;

function isCurrentZipScene(file, sceneKey) {
  return currentFile === file && currentFileType === 'zip' && currentZipSceneKey === sceneKey;
}

function isCurrentPanorama(file, sceneKey) {
  if (currentFile !== file || currentFileType === 'zip') return false;
  return getMarzipanoTileFolder(file) === sceneKey || file.name === sceneKey;
}

function isZipSceneDeleted(file, sceneKey) {
  return deletedZipScenes.get(file)?.has(sceneKey) || false;
}

function markZipSceneDeleted(file, sceneKey) {
  const deletedScenes = deletedZipScenes.get(file) || new Set();
  deletedScenes.add(sceneKey);
  deletedZipScenes.set(file, deletedScenes);
}

function resetViewerAfterDelete() {
  clearModel();
  if (panoramaViewer) {
    try {
      panoramaViewer.destroy();
    } catch (err) {
      console.warn('Deleted panorama destroy failed', err);
    }
  }
  panoramaViewer = null;
  activePanoramaScene = null;
  activePanoramaViewListener = null;
  panoramaHost.innerHTML = '';
  renderer.domElement.style.display = '';
  scene.add(defaultModel, floor, grid);
  activeModel = defaultModel;
  currentFile = null;
  currentFileType = null;
  currentMarzipanoFiles = [];
  currentZipSceneKey = null;
  currentZipArchive = null;
  currentZipExportTargets = [];
  document.querySelector('#export-btn').style.display = 'none';
  document.querySelector('#preview-btn').style.display = 'none';
  document.querySelector('#add-hotspot-btn').style.display = 'none';
  document.querySelector('#scene-name').textContent = 'Studio preview';
  document.querySelector('#scene-meta').textContent = 'DEFAULT SCENE / 01';
  status.textContent = '';
}

function resetAllState() {
  // Full reset — clears all scenes, state and viewer
  if (panoramaViewer) {
    try { panoramaViewer.destroy(); } catch (e) {}
    panoramaViewer = null;
  }
  activePanoramaScene = null;
  activePanoramaViewListener = null;
  panoramaHost.innerHTML = '';
  renderer.domElement.style.display = '';
  clearModel();
  scene.add(defaultModel, floor, grid);
  activeModel = defaultModel;

  // Clear all data maps
  currentFile = null;
  currentFileType = null;
  currentMarzipanoFiles = [];
  currentZipSceneKey = null;
  currentZipArchive = null;
  currentZipExportTargets = [];
  currentZipPreviewTileMap = {};
  currentZipPreviewUrls = new Map();
  currentZipLinkIconUrl = '';
  panoramaFileGroups = new Map();
  panoramaHotspots = new Map();
  equirectSourceFiles = new Map();
  sceneViewSettings = new Map();
  sceneInitialViewSettings = new Map();
  sceneSounds = new Map();
  sceneVideos = new Map();
  sceneTitles = new Map();
  projectBuildingDetails = {};
  currentPanoramaViewState = { yaw: 0, pitch: 0 };

  // Clear sidebar list
  const list = document.querySelector('#files');
  list.innerHTML = '<div class="empty-files">No files added yet</div>';
  document.querySelector('#file-count').textContent = '00';

  // Reset buttons
  document.querySelector('#export-btn').style.display = 'none';
  document.querySelector('#preview-btn').style.display = 'none';
  document.querySelector('#add-hotspot-btn').style.display = 'none';
  document.querySelector('#header-add-scene-trigger') && (document.querySelector('#header-add-scene-trigger').style.display = 'none');
  document.querySelector('#file-input').value = '';
  document.querySelector('#sidebar-add-scene-input').value = '';
  document.querySelector('#scene-name').textContent = 'Studio preview';
  document.querySelector('#scene-meta').textContent = 'DEFAULT SCENE / 01';
  hotspotPlacementMode = false;
  status.textContent = '';
}

function removeSceneItem(item, file, sceneKey, isZipScene) {
  const confirmationText = isZipScene
    ? 'Delete this page?\nThis action cannot be undone.'
    : 'Delete this file/page?\nThis action cannot be undone.';
  if (!window.confirm(confirmationText)) return;

  const isActive = isZipScene
    ? isCurrentZipScene(file, sceneKey)
    : currentFile === file && currentFileType !== 'zip';

  if (isZipScene) {
    markZipSceneDeleted(file, sceneKey);
    currentZipExportTargets = currentZipExportTargets.filter((target) => target.key !== sceneKey);
    panoramaHotspots.delete(sceneKey);
    sceneViewSettings.delete(sceneKey);
    sceneSounds.delete(sceneKey);
    sceneVideos.delete(sceneKey);
  } else {
    panoramaFileGroups.delete(sceneKey);
    equirectSourceFiles.delete(sceneKey);
    sceneTitles.delete(sceneKey);
  }

  item.remove();
  document.querySelector('#file-count').textContent = String(document.querySelector('#files').children.length).padStart(2, '0');
  if (isActive) resetViewerAfterDelete();
}

function editProjectDetails() {
  const dialog = document.createElement('div');
  dialog.className = 'hotspot-dialog-backdrop';
  dialog.innerHTML = `<form class="hotspot-dialog scene-properties-dialog" role="dialog" aria-modal="true"><div class="hotspot-dialog-header"><h3>Project details</h3><button type="button" class="hotspot-dialog-close" aria-label="Close">×</button></div><div class="hotspot-dialog-scroll"><p class="hotspot-dialog-meta">Property information for the entire project</p><div class="building-fields"><label>Property type<select class="building-type-input"><option value="">Select type</option><option value="Apartment">Apartment</option><option value="Villa">Villa</option><option value="Office">Office</option><option value="Shop">Shop</option><option value="Land">Land</option><option value="Other">Other</option></select></label><label>Area (m²)<input class="building-area-input" type="number" min="0" step="0.01"></label><label>Total rooms<input class="building-rooms-input" type="number" min="0" step="1"></label><label>Bedrooms<input class="building-bedrooms-input" type="number" min="0" step="1"></label><label>Bathrooms<input class="building-bathrooms-input" type="number" min="0" step="1"></label><label>Floor<input class="building-floor-input" type="text"></label><label>Total floors<input class="building-floors-input" type="number" min="0" step="1"></label><label>Year built<input class="building-year-input" type="number" min="0" step="1"></label><label>Parking spaces<input class="building-parking-input" type="number" min="0" step="1"></label><label>Storage room<input class="building-storage-input" type="text"></label><label>Heating / cooling<input class="building-climate-input" type="text"></label><label>Energy cost<input class="building-energy-cost-input" type="text"></label><label>Energy consumption<input class="building-energy-consumption-input" type="text"></label><label>Price<input class="building-price-input" type="text"></label></div><label>Address<input class="building-address-input" type="text"></label><label>Description<textarea class="building-description-input" rows="3"></textarea></label></div><div class="hotspot-dialog-actions"><button type="button" class="hotspot-cancel">Cancel</button><button type="submit" class="hotspot-confirm">Save</button></div></form>`;
  const inputs = {
    type: dialog.querySelector('.building-type-input'),
    area: dialog.querySelector('.building-area-input'),
    rooms: dialog.querySelector('.building-rooms-input'),
    bedrooms: dialog.querySelector('.building-bedrooms-input'),
    bathrooms: dialog.querySelector('.building-bathrooms-input'),
    floor: dialog.querySelector('.building-floor-input'),
    floors: dialog.querySelector('.building-floors-input'),
    yearBuilt: dialog.querySelector('.building-year-input'),
    parkingSpaces: dialog.querySelector('.building-parking-input'),
    storageRoom: dialog.querySelector('.building-storage-input'),
    climate: dialog.querySelector('.building-climate-input'),
    price: dialog.querySelector('.building-price-input'),
    energyCost: dialog.querySelector('.building-energy-cost-input'),
    energyConsumption: dialog.querySelector('.building-energy-consumption-input'),
    address: dialog.querySelector('.building-address-input'),
    description: dialog.querySelector('.building-description-input')
  };
  Object.entries(inputs).forEach(([key, input]) => { input.value = projectBuildingDetails[key] ?? ''; });
  document.body.appendChild(dialog);
  const close = (save) => {
    if (save) projectBuildingDetails = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
    dialog.remove();
  };
  dialog.querySelector('.hotspot-cancel').addEventListener('click', () => close(false));
  dialog.querySelector('.hotspot-dialog-close').addEventListener('click', () => close(false));
  dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); close(true); });
  inputs.type.focus();
}

function editSceneProperties(sceneKey) {
  const current = sceneViewSettings.get(sceneKey) || { yaw: 0, pitch: 0 };
  const currentSound = sceneSounds.get(sceneKey) || null;
  const currentVideo = sceneVideos.get(sceneKey)
    || currentZipExportTargets.find((target) => target.key === sceneKey)?.sceneVideo
    || null;
  const dialog = document.createElement('div');
  dialog.className = 'hotspot-dialog-backdrop';
  dialog.innerHTML = `<form class="hotspot-dialog scene-properties-dialog" role="dialog" aria-modal="true">
    <div class="hotspot-dialog-header"><h3>Scene properties</h3><button type="button" class="hotspot-dialog-close" aria-label="Close">×</button></div>
    <div class="hotspot-dialog-scroll"><p class="hotspot-dialog-meta">Initial view</p><div class="scene-view-fields"><label>Initial X (yaw)<input class="scene-yaw-input" type="number" step="0.01"></label><label>Initial Y (pitch)<input class="scene-pitch-input" type="number" step="0.01"></label></div><div class="scene-initial-preview"><div class="scene-initial-preview-viewer"></div><img class="scene-initial-preview-image" alt="Initial view preview"><span class="target-preview-crosshair"></span></div><label>Page avatar video<input class="scene-video-input" type="file" accept="video/*"><video class="scene-video-preview" muted controls playsinline></video><small class="scene-video-status"></small></label><label>Page sound<div class="scene-sound-controls"><input class="scene-sound-input" type="file" accept="audio/*"><button type="button" class="scene-sound-play">Play</button></div><small class="scene-sound-status"></small></label><label>Playback<select class="scene-sound-mode"><option value="once">Play once</option><option value="loop">Repeat</option></select></label></div>
    <div class="hotspot-dialog-actions"><button type="button" class="hotspot-cancel">Cancel</button><button type="submit" class="hotspot-confirm">OK</button></div>
  </form>`;
  const yawInput = dialog.querySelector('.scene-yaw-input');
  const pitchInput = dialog.querySelector('.scene-pitch-input');
  const soundInput = dialog.querySelector('.scene-sound-input');
  const soundPlayButton = dialog.querySelector('.scene-sound-play');
  const soundStatus = dialog.querySelector('.scene-sound-status');
  const soundModeInput = dialog.querySelector('.scene-sound-mode');
  const videoInput = dialog.querySelector('.scene-video-input');
  const videoStatus = dialog.querySelector('.scene-video-status');
  const videoPreview = dialog.querySelector('.scene-video-preview');
  const preview = dialog.querySelector('.scene-initial-preview');
  const previewImage = dialog.querySelector('.scene-initial-preview-image');
  const previewViewerHost = dialog.querySelector('.scene-initial-preview-viewer');
  let previewScene = null;
  yawInput.value = Number(current.yaw || 0).toFixed(2);
  pitchInput.value = Number(current.pitch || 0).toFixed(2);
  videoStatus.textContent = currentVideo?.name ? `Current avatar video: ${currentVideo.name}` : 'No avatar video selected';
  videoStatus.classList.toggle('is-selected', Boolean(currentVideo));
  const currentVideoUrl = currentVideo?.url || (currentVideo?.file ? URL.createObjectURL(currentVideo.file) : '');
  if (currentVideoUrl) {
    videoPreview.src = currentVideoUrl;
    videoPreview.hidden = false;
  } else {
    videoPreview.hidden = true;
  }
  videoInput.addEventListener('change', () => {
    const file = videoInput.files?.[0];
    videoStatus.textContent = file ? `New avatar video: ${file.name}` : (currentVideo?.name ? `Current avatar video: ${currentVideo.name}` : 'No avatar video selected');
    videoStatus.classList.toggle('is-selected', Boolean(file || currentVideo));
    if (file) {
      videoPreview.src = URL.createObjectURL(file);
      videoPreview.hidden = false;
    }
  });
  document.body.appendChild(dialog);
  previewScene = createTargetPreviewViewer(sceneKey, previewViewerHost, previewImage);
  previewScene?.view.setParameters({ yaw: Number(yawInput.value || 0), pitch: Number(pitchInput.value || 0), fov: 100 * Math.PI / 180 });
  const updatePreviewView = () => {
    const yaw = Number(yawInput.value || 0);
    const pitch = Number(pitchInput.value || 0);
    previewScene?.view.setParameters({ yaw, pitch, fov: 100 * Math.PI / 180 });
    if (!previewScene) {
      previewImage.style.transform = `translateX(${yaw * 18}px) translateY(${-pitch * 18}px) scale(1.15)`;
    }
  };
  previewScene?.view.addEventListener('change', () => {
    const view = previewScene.view;
    yawInput.value = Number(view.yaw()).toFixed(2);
    pitchInput.value = Number(view.pitch()).toFixed(2);
  });
  yawInput.addEventListener('input', updatePreviewView);
  pitchInput.addEventListener('input', updatePreviewView);
  preview.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    preview.setPointerCapture?.(event.pointerId);
    const rect = preview.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startYaw = Number(yawInput.value || 0);
    const startPitch = Number(pitchInput.value || 0);
    const move = (moveEvent) => {
      const newYaw = startYaw + (moveEvent.clientX - startX) / rect.width * Math.PI * 2;
      const newPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, startPitch - (moveEvent.clientY - startY) / rect.height * Math.PI));
      yawInput.value = newYaw.toFixed(2);
      pitchInput.value = newPitch.toFixed(2);
      updatePreviewView();
    };
    const stop = () => {
      preview.removeEventListener('pointermove', move);
      preview.removeEventListener('pointerup', stop);
      preview.removeEventListener('pointercancel', stop);
    };
    preview.addEventListener('pointermove', move);
    preview.addEventListener('pointerup', stop);
    preview.addEventListener('pointercancel', stop);
  });
  updatePreviewView();
  soundStatus.textContent = currentSound?.name ? `Current page sound: ${currentSound.name}` : 'No page sound selected';
  soundStatus.classList.toggle('is-selected', Boolean(currentSound));
  soundModeInput.value = currentSound?.loop ? 'loop' : 'once';
  let previewAudio = null;
  soundInput.addEventListener('change', () => {
    const file = soundInput.files?.[0];
    soundStatus.textContent = file ? `New page sound: ${file.name}` : (currentSound?.name ? `Current page sound: ${currentSound.name}` : 'No page sound selected');
    soundStatus.classList.toggle('is-selected', Boolean(file || currentSound));
  });
  soundPlayButton.addEventListener('click', () => {
    previewAudio?.pause();
    const file = soundInput.files?.[0];
    const soundUrl = file ? URL.createObjectURL(file) : (currentSound?.url || (currentSound?.file ? URL.createObjectURL(currentSound.file) : null));
    if (!soundUrl) return;
    previewAudio = new Audio(soundUrl);
    previewAudio.loop = soundModeInput.value === 'loop';
    previewAudio.play().catch(() => {});
  });
  const close = (save) => {
    if (save) {
      const settings = { yaw: Number(yawInput.value) || 0, pitch: Number(pitchInput.value) || 0 };
      sceneViewSettings.set(sceneKey, settings);
      sceneInitialViewSettings.set(sceneKey, settings);
      const soundFile = soundInput.files?.[0];
      const videoFile = videoInput.files?.[0];
      if (videoFile) sceneVideos.set(sceneKey, { url: null, file: videoFile, name: videoFile.name });
      else if (currentVideo) sceneVideos.set(sceneKey, currentVideo);
      if (soundFile) {
        sceneSounds.set(sceneKey, { url: null, file: soundFile, name: soundFile.name, loop: soundModeInput.value === 'loop' });
      } else if (currentSound) {
        currentSound.loop = soundModeInput.value === 'loop';
        sceneSounds.set(sceneKey, currentSound);
      }
      const storedTarget = currentZipExportTargets.find((target) => target.key === sceneKey);
      if (storedTarget) {
        const savedVideo = sceneVideos.get(sceneKey) || null;
        storedTarget.yaw = settings.yaw;
        storedTarget.pitch = settings.pitch;
        storedTarget.sceneVideo = savedVideo;
        storedTarget.initialViewParameters = {
          ...(storedTarget.initialViewParameters || {}),
          yaw: settings.yaw,
          pitch: settings.pitch
        };
      }
      if (currentPanoramaKey() === sceneKey && activePanoramaScene?.view) {
        activePanoramaScene.view().setParameters(settings);
        currentPanoramaViewState = settings;
      }
    }
    previewAudio?.pause();
    previewScene?.viewer?.destroy();
    dialog.remove();
  };
  dialog.querySelector('.hotspot-cancel').addEventListener('click', () => close(false));
  dialog.querySelector('.hotspot-dialog-close').addEventListener('click', () => close(false));
  dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); close(true); });
  yawInput.focus();
}

function getViewAngles(view) {
  if (!view) return { yaw: 0, pitch: 0 };
  return {
    yaw: typeof view.yaw === 'function' ? view.yaw() : view.yaw,
    pitch: typeof view.pitch === 'function' ? view.pitch() : view.pitch
  };
}

function currentPanoramaKey() {
  if (!currentFile) return 'default';
  if (currentFileType === 'zip' && currentZipSceneKey) return currentZipSceneKey;
  return getMarzipanoTileFolder(currentFile) || currentFile.name;
}

function getSceneTitle(key, fallback) {
  return sceneTitles.get(key) || fallback || key;
}

// Looks up sceneVideos / sceneSounds by canonical key (no ext) OR full filename (with ext).
// Needed because editSceneProperties uses displayName (with .jpg) as key,
// but buildExportTargets iterates equirectSourceFiles using canonical key (no ext).
function getSceneVideo(key) {
  return sceneVideos.get(key) || sceneVideos.get(key.replace(/\.[^/.]+$/, '')) || sceneVideos.get(`${key}.jpg`) || sceneVideos.get(`${key}.jpeg`) || sceneVideos.get(`${key}.png`) || null;
}
function getSceneSound(key) {
  return sceneSounds.get(key) || sceneSounds.get(key.replace(/\.[^/.]+$/, '')) || sceneSounds.get(`${key}.jpg`) || sceneSounds.get(`${key}.jpeg`) || sceneSounds.get(`${key}.png`) || null;
}

// Gets the user-set initial view for a scene key, trying both canonical and full-filename forms.
function getInitialView(key, fallback) {
  return sceneInitialViewSettings.get(key)
    || sceneInitialViewSettings.get(key.replace(/\.[^/.]+$/, ''))
    || sceneInitialViewSettings.get(`${key}.jpg`)
    || sceneInitialViewSettings.get(`${key}.jpeg`)
    || fallback
    || { yaw: 0, pitch: 0 };
}

function getHotspotsForPanoramaKey(key) {
  if (!key) return [];
  const list = panoramaHotspots.get(key) || [];
  if (panoramaHotspots.has(key)) return list;

  const currentKey = currentPanoramaKey();
  const activeHotspots = panoramaHotspots.get(currentKey) || [];
  if (activeHotspots.length) return activeHotspots;

  const fallbackKey = currentPanoramaKey();
  if (fallbackKey && fallbackKey !== key) {
    return panoramaHotspots.get(fallbackKey) || [];
  }
  return list;
}

function getCoordsFromPointerEvent(event) {
  const rect = panoramaHost.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;

  if (activePanoramaScene && activePanoramaScene.view) {
    const view = activePanoramaScene.view();
    const coords = view.screenToCoordinates({ x: localX, y: localY });
    if (coords && Number.isFinite(coords.yaw) && Number.isFinite(coords.pitch)) {
      return { yaw: coords.yaw, pitch: coords.pitch };
    }
  }

  const x = localX / rect.width;
  const y = localY / rect.height;
  return {
    yaw: (x - 0.5) * 2.8,
    pitch: (0.5 - y) * 1.8
  };
}

function formatHotspotLabel(hotspot) {
  const label = hotspot.label || 'Hotspot';
  const x = Number.isFinite(Number(hotspot.yaw)) ? Number(hotspot.yaw).toFixed(2) : '0.00';
  const y = Number.isFinite(Number(hotspot.pitch)) ? Number(hotspot.pitch).toFixed(2) : '0.00';
  return `${label}\nX: ${x}\nY: ${y}`;
}

let activeHotspotAudio = null;
function playHotspotSound(hotspot) {
  if (!hotspot.sound?.url) return;
  activeHotspotAudio?.pause();
  activeHotspotAudio = new Audio(hotspot.sound.url);
  activeHotspotAudio.loop = Boolean(hotspot.sound.loop);
  activeHotspotAudio.play().catch(() => {});
}

function getHotspotTargetOptions() {
  const keys = currentZipExportTargets.map((target) => target.key);
  panoramaFileGroups.forEach((files, key) => {
    if (!keys.includes(key)) keys.push(key);
  });
  // Plain equirectangular JPGs are tracked in equirectSourceFiles (not panoramaFileGroups).
  // Use the extension-free key (canonical scene key) so it matches sceneViewSettings etc.
  equirectSourceFiles.forEach((file, key) => {
    // Skip the duplicate entry that stores the full filename (e.g. "img.jpg")
    // — only keep the canonical key without extension.
    if (/\.[^/.]+$/.test(key)) return;
    if (!keys.includes(key)) keys.push(key);
  });
  return keys;
}

function getScenePreviewUrl(key) {
  if (currentZipPreviewUrls.has(key)) return currentZipPreviewUrls.get(key);
  const files = panoramaFileGroups.get(key) || [];
  const previewFile = files.find((file) => isPreviewFile(file)) || files.find((file) => /\.(jpe?g|png)$/i.test(file.name));
  return previewFile ? URL.createObjectURL(previewFile) : '';
}

function createTargetPreviewViewer(key, host, image) {
  const localFiles = panoramaFileGroups.get(key) || [];
  const localPreviewFile = localFiles.find((file) => isPreviewFile(file));
  const localPreviewUrl = localPreviewFile ? URL.createObjectURL(localPreviewFile) : '';
  const localTileMap = new Map();
  localFiles.forEach((file) => {
    const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
    const segments = relative.split('/').filter(Boolean);
    const levelIndex = segments.findIndex((segment) => /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment));
    if (levelIndex <= 0) return;
    const suffix = segments.slice(levelIndex).join('/');
    if (/\.(jpe?g|png)$/i.test(suffix)) localTileMap.set(suffix, URL.createObjectURL(file));
  });
  const hasZipTiles = currentZipPreviewUrls.has(key) || Object.keys(currentZipPreviewTileMap).some((path) => path.startsWith(`${key}/`));
  const hasLocalTiles = localTileMap.size > 0;

  // For plain equirect JPGs: use the already-generated tiles from officialEquirectResults.
  const equirectSourceFile = equirectSourceFiles.get(key);
  const generatedEquirect = equirectSourceFile ? officialEquirectResults.get(equirectSourceFile) : null;

  // Also try stripping the extension — displayName may be 'img.jpg' while key stored is 'img'
  const equirectSourceFileAlt = !equirectSourceFile
    ? equirectSourceFiles.get(key.replace(/\.[^/.]+$/, ''))
    : null;
  const generatedEquirectAlt = equirectSourceFileAlt ? officialEquirectResults.get(equirectSourceFileAlt) : null;
  const resolvedEquirect = generatedEquirect || generatedEquirectAlt;
  const resolvedSourceFile = equirectSourceFile || equirectSourceFileAlt;

  if (!hasZipTiles && !hasLocalTiles && !resolvedEquirect) {
    // Show static preview if image not yet processed
    const staticUrl = resolvedSourceFile ? URL.createObjectURL(resolvedSourceFile) : getScenePreviewUrl(key);
    image.src = staticUrl;
    image.style.display = 'block';
    return null;
  }
  image.style.display = 'none';
  const previewUrl = currentZipPreviewUrls.get(key) || localPreviewUrl || getScenePreviewUrl(key);

  // Build the tile source — prefer generated equirect tiles when available.
  let source;
  let geometry;
  if (resolvedEquirect) {
    const equirectSource = createOfficialEquirectSource(resolvedEquirect);
    source = equirectSource.source;
    geometry = equirectSource.geometry;
  } else {
    source = new Marzipano.ImageUrlSource((tile) => {
      const level = Number(tile.z || 0);
      const face = String(tile.face || '').toLowerCase();
      const row = Number(tile.y || 0);
      const column = Number(tile.x || 0);
      if (level === 0 && previewUrl) {
        const faceIndex = 'bdflru'.indexOf(face);
        if (faceIndex >= 0) return { url: previewUrl, rect: { x: 0, y: faceIndex / 6, width: 1, height: 1 / 6 } };
      }
      const paths = hasLocalTiles
        ? [`${level}/${face}/${row}/${column}.jpg`, `${level}/${face}/${row}/${column}.png`]
        : [`${key}/${level}/${face}/${row}/${column}.jpg`, `${key}/${level}/${face}/${row}/${column}.png`];
      const path = paths.find((candidate) => localTileMap.has(candidate) || currentZipPreviewTileMap[candidate]);
      return { url: path ? (localTileMap.get(path) || currentZipPreviewTileMap[path]) : previewUrl };
    });
    geometry = new Marzipano.CubeGeometry([
      { tileSize: 256, size: 256, fallbackOnly: true },
      { tileSize: 512, size: 512 },
      { tileSize: 512, size: 1024 },
    ]);
  }

  const view = new Marzipano.RectilinearView({ yaw: 0, pitch: 0, fov: 120 * Math.PI / 180 });
  const viewer = new Marzipano.Viewer(host, { stage: { progressive: true } });
  const scene = viewer.createScene({ source, geometry, view, pinFirstLevel: true });
  scene.switchTo();
  return { viewer, view };
}

function editHotspotProperties(hotspot, isNew = false) {
  const keys = getHotspotTargetOptions();
  const targetKey = hotspot.target || currentPanoramaKey();
  const dialog = document.createElement('div');
  dialog.className = 'hotspot-dialog-backdrop';
  dialog.innerHTML = `
    <form class="hotspot-dialog" role="dialog" aria-modal="true">
      <div class="hotspot-dialog-header"><h3>Hotspot properties</h3><button type="button" class="hotspot-dialog-close" aria-label="Close">×</button></div>
      <div class="hotspot-dialog-scroll">
        <p class="hotspot-dialog-meta">Current position: X ${Number(hotspot.yaw || 0).toFixed(2)} · Y ${Number(hotspot.pitch || 0).toFixed(2)}</p>
        <label>Hint text<input class="hotspot-label-input" type="text" value=""></label>
        <label>Target scene<select class="hotspot-target-input"></select></label>
        <label>Hotspot sound<div class="hotspot-sound-controls"><input class="hotspot-sound-input" type="file" accept="audio/*"><button type="button" class="hotspot-sound-play">Play</button></div><small class="hotspot-sound-status"></small><small class="hotspot-sound-name"></small></label>
        <label>Playback<select class="hotspot-sound-mode"><option value="once">Play once</option><option value="loop">Repeat</option></select></label>
        <div class="hotspot-visual-fields"><label>Hotspot size (%)<input class="hotspot-size-input" type="number" min="50" max="200" step="5" value="100"></label><label>Hotspot rotation (degrees)<input class="hotspot-rotation-input" type="number" min="-360" max="360" step="1" value="0"></label></div>
        <div class="hotspot-angle-fields"><label>Target yaw<input class="hotspot-target-yaw" type="number" step="0.01" value="0"></label><label>Target pitch<input class="hotspot-target-pitch" type="number" step="0.01" value="0"></label><label>Target FOV<input class="hotspot-target-fov" type="number" min="30" max="120" step="1" value="120"></label></div>
        <div class="target-preview-wrap"><div class="target-preview-head"><span>Drag to aim at a view</span><span class="target-preview-values"></span></div><div class="target-preview"><div class="target-preview-viewer"></div><img class="target-preview-image" alt="Target scene preview"><span class="target-preview-crosshair"></span></div></div>
      </div>
      <div class="hotspot-dialog-actions"><button type="button" class="hotspot-delete">Delete hotspot</button><button type="button" class="hotspot-cancel">Cancel</button><button type="submit" class="hotspot-confirm">OK</button></div>
    </form>`;
  const labelInput = dialog.querySelector('.hotspot-label-input');
  const targetInput = dialog.querySelector('.hotspot-target-input');
  const soundInput = dialog.querySelector('.hotspot-sound-input');
  const soundStatus = dialog.querySelector('.hotspot-sound-status');
  const soundName = dialog.querySelector('.hotspot-sound-name');
  const soundModeInput = dialog.querySelector('.hotspot-sound-mode');
  const soundPlayButton = dialog.querySelector('.hotspot-sound-play');
  const sizeInput = dialog.querySelector('.hotspot-size-input');
  const rotationInput = dialog.querySelector('.hotspot-rotation-input');
  const targetYawInput = dialog.querySelector('.hotspot-target-yaw');
  const targetPitchInput = dialog.querySelector('.hotspot-target-pitch');
  const targetFovInput = dialog.querySelector('.hotspot-target-fov');
  const targetPreview = dialog.querySelector('.target-preview');
  const targetPreviewImage = dialog.querySelector('.target-preview-image');
  const targetPreviewViewerHost = dialog.querySelector('.target-preview-viewer');
  const targetPreviewValues = dialog.querySelector('.target-preview-values');
  let targetPreviewScene = null;
  const updateTargetValues = () => {
    targetPreviewValues.textContent = `Y ${Number(targetYawInput.value || 0).toFixed(2)} · P ${Number(targetPitchInput.value || 0).toFixed(2)} · F ${Number(targetFovInput.value || 120).toFixed(0)}°`;
  };
  labelInput.value = hotspot.label || 'Hotspot';
  sizeInput.value = Math.min(200, Math.max(50, Number(hotspot.sizePercent) || 100));
  rotationInput.value = Math.round(Number(hotspot.rotation || 0) * 180 / Math.PI);
  const currentSoundName = hotspot.sound?.name || (hotspot.sound?.url ? 'Saved sound' : '');
  soundStatus.textContent = currentSoundName ? `Current sound: ${currentSoundName}` : 'No sound selected';
  soundStatus.classList.toggle('is-selected', Boolean(currentSoundName));
  soundName.textContent = '';
  soundModeInput.value = hotspot.sound?.loop ? 'loop' : 'once';
  soundInput.addEventListener('change', () => {
    const selectedName = soundInput.files?.[0]?.name || '';
    soundStatus.textContent = selectedName ? `New sound ready: ${selectedName}` : (currentSoundName ? `Current sound: ${currentSoundName}` : 'No sound selected');
    soundStatus.classList.toggle('is-selected', Boolean(selectedName || currentSoundName));
  });
  let previewAudio = null;
  soundPlayButton.addEventListener('click', () => {
    previewAudio?.pause();
    const soundFile = soundInput.files?.[0];
    const soundUrl = soundFile
      ? URL.createObjectURL(soundFile)
      : (hotspot.sound?.url || (hotspot.sound?.file ? URL.createObjectURL(hotspot.sound.file) : null));
    if (!soundUrl) return;
    previewAudio = new Audio(soundUrl);
    previewAudio.loop = soundModeInput.value === 'loop';
    previewAudio.play().catch(() => {});
  });
  targetYawInput.value = Number(hotspot.targetYaw ?? hotspot.targetViewParameters?.yaw ?? 0).toFixed(2);
  targetPitchInput.value = Number(hotspot.targetPitch ?? hotspot.targetViewParameters?.pitch ?? 0).toFixed(2);
  targetFovInput.value = Number(hotspot.targetFov ?? hotspot.targetViewParameters?.fov ?? 120);
  const updateTargetPreview = () => {
    targetPreviewScene?.viewer?.destroy();
    targetPreviewViewerHost.innerHTML = '';
    targetPreviewScene = createTargetPreviewViewer(targetInput.value || targetKey, targetPreviewViewerHost, targetPreviewImage);
    if (targetPreviewScene) {
      targetPreviewScene.view.setParameters({
        yaw: Number(targetYawInput.value || 0),
        pitch: Number(targetPitchInput.value || 0),
        fov: Number(targetFovInput.value || 120) * Math.PI / 180
      });
      targetPreviewScene.view.addEventListener('change', () => {
        const fov = typeof targetPreviewScene.view.fov === 'function'
          ? targetPreviewScene.view.fov()
          : targetPreviewScene.view.parameters().fov;
        if (Number.isFinite(fov)) {
          targetFovInput.value = Math.min(120, Math.max(30, fov * 180 / Math.PI)).toFixed(0);
          updateTargetValues();
        }
      });
    }
    updateTargetValues();
  };
  keys.forEach((key) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = getSceneTitle(key, key);
    option.selected = key === targetKey;
    targetInput.appendChild(option);
  });
  if (!keys.length) {
    const option = document.createElement('option');
    option.value = currentPanoramaKey();
    option.textContent = getSceneTitle(option.value, option.value);
    targetInput.appendChild(option);
  }
  targetInput.addEventListener('change', updateTargetPreview);
  targetPreview.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    targetPreview.setPointerCapture?.(event.pointerId);
    const rect = targetPreview.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startYaw = Number(targetYawInput.value || 0);
    const startPitch = Number(targetPitchInput.value || 0);
    const updateAngles = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (Math.hypot(deltaX, deltaY) < 3) return;
      targetYawInput.value = (startYaw + (deltaX / rect.width) * Math.PI * 2).toFixed(2);
      targetPitchInput.value = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, startPitch - (deltaY / rect.height) * Math.PI)).toFixed(2);
      updateTargetValues();
      targetPreviewScene?.view.setParameters({ yaw: Number(targetYawInput.value), pitch: Number(targetPitchInput.value) });
    };
    const stopDragging = () => {
      targetPreview.removeEventListener('pointermove', updateAngles);
      targetPreview.removeEventListener('pointerup', stopDragging);
      targetPreview.removeEventListener('pointercancel', stopDragging);
    };
    targetPreview.addEventListener('pointermove', updateAngles);
    targetPreview.addEventListener('pointerup', stopDragging);
    targetPreview.addEventListener('pointercancel', stopDragging);
  });
  document.body.appendChild(dialog);
  updateTargetPreview();
  labelInput.focus();

  return new Promise((resolve) => {
    const close = async (accepted, deleted = false) => {
      if (deleted) {
        const confirmed = window.confirm('Delete this hotspot?\nThis action cannot be undone.');
        if (!confirmed) {
          dialog.remove();
          previewAudio?.pause();
          targetPreviewScene?.viewer?.destroy();
          resolve(false);
          return;
        }
        const removed = removeHotspotFromMap(panoramaHotspots, currentPanoramaKey(), hotspot);
        if (!removed) {
          const matchingTarget = currentZipExportTargets.find((target) => target.key === currentPanoramaKey());
          if (matchingTarget) {
            matchingTarget.hotspots = (matchingTarget.hotspots || []).filter((entry) => entry !== hotspot && entry?.id !== hotspot?.id);
          }
        }
        renderHotspotsForCurrentPanorama();
      } else if (accepted) {
        hotspot.label = labelInput.value.trim() || 'Hotspot';
        hotspot.target = targetInput.value || currentPanoramaKey();
        hotspot.targetYaw = Number(targetYawInput.value) || 0;
        hotspot.targetPitch = Number(targetPitchInput.value) || 0;
        hotspot.targetFov = Math.min(120, Math.max(30, Number(targetFovInput.value) || 120));
        hotspot.targetViewParameters = {
          yaw: hotspot.targetYaw,
          pitch: hotspot.targetPitch,
          fov: hotspot.targetFov
        };
        hotspot.sizePercent = Math.min(200, Math.max(50, Number(sizeInput.value) || 100));
        hotspot.rotation = Number(rotationInput.value || 0) * Math.PI / 180;
        const soundFile = soundInput.files?.[0];
        if (soundFile) {
          // Store file object directly (like sceneSound) — avoid large data URLs
          hotspot.sound = { url: null, file: soundFile, name: soundFile.name, loop: soundModeInput.value === 'loop' };
        } else if (hotspot.sound) {
          hotspot.sound.loop = soundModeInput.value === 'loop';
        }
        if (!isNew) renderHotspotsForCurrentPanorama();
      }
      dialog.remove();
      previewAudio?.pause();
      targetPreviewScene?.viewer?.destroy();
      resolve(accepted);
    };
    dialog.querySelector('.hotspot-delete').addEventListener('click', () => close(false, true));
    dialog.querySelector('.hotspot-cancel').addEventListener('click', () => close(false));
    dialog.querySelector('.hotspot-dialog-close').addEventListener('click', () => close(false));
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      close(true);
    });
  });
}

function renderHotspotsForCurrentPanorama() {
  if (!activePanoramaScene) return;
  const container = activePanoramaScene.hotspotContainer();
  const existing = container.listHotspots();
  existing.forEach((hotspot) => container.destroyHotspot(hotspot));

  const hotspots = getHotspotsForPanoramaKey(currentPanoramaKey());
  hotspots.forEach((hotspot) => {
    const marker = document.createElement('div');
    marker.className = 'hotspot-object';
    const hotspotScale = Math.min(2, Math.max(.5, Number(hotspot.sizePercent || 100) / 100));
    marker.setAttribute('role', 'button');
    marker.setAttribute('tabindex', '0');
    marker.title = hotspot.label || 'Hotspot';

    if (currentZipLinkIconUrl) {
      const icon = document.createElement('img');
      icon.className = 'hotspot-object-icon';
      icon.src = currentZipLinkIconUrl;
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
    label.textContent = formatHotspotLabel(hotspot);
    marker.appendChild(label);
    marker.title = formatHotspotLabel(hotspot);

    const hotspotInstance = container.createHotspot(marker, { yaw: hotspot.yaw, pitch: hotspot.pitch });
    hotspot.instance = hotspotInstance;

    marker.addEventListener('pointerdown', (event) => {
      if (!hotspotPlacementMode) {
        event.stopPropagation();
        event.preventDefault();
        marker.style.touchAction = 'none';
        marker.setPointerCapture?.(event.pointerId);
        const startCoords = getCoordsFromPointerEvent(event);
        const dragState = {
          active: true,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          hasMoved: false,
          startYaw: startCoords.yaw,
          startPitch: startCoords.pitch,
          hotspotYaw: hotspot.yaw,
          hotspotPitch: hotspot.pitch
        };
        marker.dataset.drag = 'active';
        marker._dragState = dragState;
        status.textContent = 'Drag hotspot to reposition';
      }
    });

    marker.addEventListener('click', (event) => {
      if (marker.dataset.drag === 'active' || marker.dataset.drag === 'dragging' || marker.dataset.drag === 'done') {
        return;
      }
      event.stopPropagation();
      editHotspotProperties(hotspot);
    });

    marker.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        marker.click();
      }
    });

    const dragMove = (event) => {
      if (!marker._dragState || marker._dragState.pointerId !== event.pointerId) return;
      const movedX = event.clientX - marker._dragState.startX;
      const movedY = event.clientY - marker._dragState.startY;
      if (!marker._dragState.hasMoved && Math.hypot(movedX, movedY) < 4) return;
      marker._dragState.hasMoved = true;
      const pointerCoords = getCoordsFromPointerEvent(event);
      hotspot.yaw = marker._dragState.hotspotYaw + (pointerCoords.yaw - marker._dragState.startYaw);
      hotspot.pitch = marker._dragState.hotspotPitch + (pointerCoords.pitch - marker._dragState.startPitch);
      hotspotInstance.setPosition({ yaw: hotspot.yaw, pitch: hotspot.pitch });
      if (marker.querySelector('.hotspot-object-label')) {
        marker.querySelector('.hotspot-object-label').textContent = formatHotspotLabel(hotspot);
      }
      marker.title = formatHotspotLabel(hotspot);
      marker.dataset.drag = 'dragging';
      status.textContent = 'Hotspot moved';
    };

    marker.addEventListener('pointermove', dragMove);
    marker.addEventListener('pointerup', (event) => {
      if (marker._dragState && marker._dragState.pointerId === event.pointerId) {
        const hasMoved = marker._dragState.hasMoved;
        marker._dragState = null;
        marker.dataset.drag = hasMoved ? 'done' : '';
        setTimeout(() => { marker.dataset.drag = ''; status.textContent = ''; }, hasMoved ? 400 : 0);
      }
    });
  });
}

async function addHotspotAtPosition(yaw, pitch, label = 'Hotspot') {
  const key = currentPanoramaKey();
  if (!key) return;
  const hotspotList = getHotspotsForPanoramaKey(key);
  const hotspot = { id: Date.now() + Math.random(), yaw, pitch, label, target: currentPanoramaKey() };
  if (!await editHotspotProperties(hotspot, true)) return;
  hotspotList.push(hotspot);
  panoramaHotspots.set(key, hotspotList);
  renderHotspotsForCurrentPanorama();
}

function buildExportTargets() {
  const currentKey = currentPanoramaKey();
  const activeHotspots = panoramaHotspots.get(currentKey) || [];
  const sceneName = document.querySelector('#scene-name')?.textContent || 'scene';

  if (currentZipExportTargets.length) {
    const importedTargets = currentZipExportTargets.map((target) => {
      const initView = getInitialView(target.key, { yaw: target.yaw || 0, pitch: target.pitch || 0 });
      return {
        ...target,
        label: getSceneTitle(target.key, target.label),
        exportSource: 'zip',
        yaw: initView.yaw,
        pitch: initView.pitch,
        initialViewParameters: {
          yaw: Number(initView.yaw) || 0,
          pitch: Number(initView.pitch) || 0,
          fov: Number(target.fov) || Math.PI / 2
        },
        sceneSound: sceneSounds.get(target.key) || target.sceneSound || null,
        sceneVideo: sceneVideos.get(target.key) || target.sceneVideo || null,
        projectDetails: projectBuildingDetails,
        hotspots: panoramaHotspots.get(target.key) || target.hotspots || []
      };
    });
    const importedKeys = new Set(importedTargets.map((target) => target.key));

    // Collect added scenes from panoramaFileGroups (tile folders only).
    // Skip plain JPG entries that are already tracked in equirectSourceFiles
    // — those will be handled separately as addedEquirectTargets below.
    const addedTargets = [...panoramaFileGroups.entries()]
      .filter(([key]) => {
        // A panoramaFileGroups entry for a plain JPG has key = file.name (with extension).
        // If its canonical key (no ext) exists in equirectSourceFiles, skip it here.
        const canonicalKey = key.replace(/\.[^/.]+$/, '');
        return !equirectSourceFiles.has(canonicalKey);
      })
      .map(([key, files]) => ({
        key: importedKeys.has(key) ? `${key}-folder` : key,
        label: getSceneTitle(key, key),
        exportSource: 'folder',
        root: `./tiles/${importedKeys.has(key) ? `${key}-folder` : key}`,
        previewUrl: `./tiles/${importedKeys.has(key) ? `${key}-folder` : key}/preview.jpg`,
        geometryType: 'equirect',
        yaw: 0,
        pitch: 0,
        projectDetails: projectBuildingDetails,
        hotspots: panoramaHotspots.get(key) || []
      }));

    // Also collect plain equirect JPGs added on top of a ZIP project.
    // equirectSourceFiles stores canonical (no-ext) key → File.
    const addedEquirectTargets = [];
    equirectSourceFiles.forEach((file, key) => {
      if (/\.[^/.]+$/.test(key)) return; // skip full-filename duplicates
      if (importedKeys.has(key)) return; // already in ZIP
      if (addedTargets.some((t) => t.key === key)) return; // already from panoramaFileGroups
      const viewState = sceneViewSettings.get(key) || { yaw: 0, pitch: 0 };
      addedEquirectTargets.push({
        key,
        label: getSceneTitle(key, key),
        exportSource: 'equirect',
        root: `./tiles/${key}`,
        previewUrl: `./tiles/${key}/preview.jpg`,
        geometryType: 'equirect',
        yaw: viewState.yaw,
        pitch: viewState.pitch,
        initialViewParameters: { yaw: Number(viewState.yaw) || 0, pitch: Number(viewState.pitch) || 0, fov: Math.PI / 2 },
        projectDetails: projectBuildingDetails,
        hotspots: panoramaHotspots.get(key) || []
      });
    });

    const targets = [...importedTargets, ...addedTargets, ...addedEquirectTargets];
    const rows = [...document.querySelectorAll('#files .file-name')];
    const orderOf = (target) => rows.findIndex((row) => target.exportSource === 'zip'
      ? row.dataset.fileName?.endsWith(`:${target.key}`)
      : row.dataset.fileName === target.key.replace(/-folder$/, ''));
    return targets.sort((left, right) => {
      const leftOrder = orderOf(left);
      const rightOrder = orderOf(right);
      return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) - (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder);
    });
  }

  const panoramaEntries = [...panoramaFileGroups.entries()].map(([key, files]) => {
    const keyHotspots = panoramaHotspots.get(key) || [];
    const targetHotspots = keyHotspots.length ? keyHotspots : activeHotspots.length ? activeHotspots : [];
    const initView = getInitialView(key, sceneViewSettings.get(key));

    return {
      key,
      label: getSceneTitle(key, key),
      root: `./tiles/${key}`,
      previewUrl: `./tiles/${key}/preview.jpg`,
      geometryType: 'cube',
      yaw: initView.yaw,
      pitch: initView.pitch,
      initialViewParameters: {
        yaw: Number(initView.yaw) || 0,
        pitch: Number(initView.pitch) || 0,
        fov: Math.PI / 2
      },
      sceneSound: getSceneSound(key) || null,
      sceneVideo: getSceneVideo(key) || null,
      projectDetails: projectBuildingDetails,
      hotspots: targetHotspots.map((hotspot) => ({
        label: hotspot.label || 'Hotspot',
        yaw: hotspot.yaw,
        pitch: hotspot.pitch,
        target: hotspot.target || currentKey,
        sizePercent: hotspot.sizePercent,
        rotation: hotspot.rotation,
        targetFov: hotspot.targetFov,
        targetViewParameters: hotspot.targetViewParameters,
        sound: hotspot.sound
      }))
    };
  });
  const rows = [...document.querySelectorAll('#files .file-name')];
  const orderOf = (entry) => rows.findIndex((row) => row.dataset.fileName === entry.key);
  panoramaEntries.sort((left, right) => {
    const leftOrder = orderOf(left);
    const rightOrder = orderOf(right);
    return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) - (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder);
  });

  const fallbackKey = getMarzipanoTileFolder(currentFile) || currentFile?.name?.replace(/\.[^/.]+$/, '') || 'panorama';
  const fallbackHotspots = panoramaHotspots.get(fallbackKey) || [];
  const fallbackEntryHotspots = fallbackHotspots.length ? fallbackHotspots : activeHotspots.length ? activeHotspots : [];
  const fallbackInitView = getInitialView(fallbackKey, currentPanoramaViewState);
  const fallbackEntry = {
    key: fallbackKey,
    label: getMarzipanoTileFolder(currentFile) || currentFile?.name || 'panorama',
    root: `./tiles/${fallbackKey}`,
    previewUrl: `./tiles/${fallbackKey}/preview.jpg`,
    geometryType: panoramaFileGroups.size ? 'cube' : 'equirect',
    yaw: fallbackInitView.yaw,
    pitch: fallbackInitView.pitch,
    initialViewParameters: {
      yaw: Number(fallbackInitView.yaw) || 0,
      pitch: Number(fallbackInitView.pitch) || 0,
      fov: Math.PI / 2
    },
    sceneSound: getSceneSound(fallbackKey) || null,
    sceneVideo: getSceneVideo(fallbackKey) || null,
    projectDetails: projectBuildingDetails,
    hotspots: fallbackEntryHotspots.map((hotspot) => ({
      label: hotspot.label || 'Hotspot',
      yaw: hotspot.yaw,
      pitch: hotspot.pitch,
      target: hotspot.target || fallbackKey,
      sizePercent: hotspot.sizePercent,
      rotation: hotspot.rotation,
      targetFov: hotspot.targetFov,
      targetViewParameters: hotspot.targetViewParameters,
      sound: hotspot.sound
    }))
  };

  const entryMap = new Map();
  panoramaEntries.forEach((entry) => entryMap.set(entry.key, entry));

  // Add all plain equirectangular JPGs that were loaded but are not yet in entryMap.
  // equirectSourceFiles stores each file under TWO keys: canonical (no ext) + full filename.
  // Only process the canonical key (no extension) to avoid duplicate entries.
  equirectSourceFiles.forEach((file, key) => {
    if (/\.[^/.]+$/.test(key)) return;
    if (entryMap.has(key)) return;
    const keyHotspots = panoramaHotspots.get(key) || [];
    const initView = getInitialView(key, key === currentKey ? currentPanoramaViewState : { yaw: 0, pitch: 0 });
    entryMap.set(key, {
      key,
      label: getSceneTitle(key, key),
      root: `./tiles/${key}`,
      previewUrl: `./tiles/${key}/preview.jpg`,
      geometryType: 'equirect',
      yaw: initView.yaw,
      pitch: initView.pitch,
      initialViewParameters: {
        yaw: Number(initView.yaw) || 0,
        pitch: Number(initView.pitch) || 0,
        fov: Math.PI / 2
      },
      sceneSound: getSceneSound(key) || null,
      sceneVideo: getSceneVideo(key) || null,
      projectDetails: projectBuildingDetails,
      hotspots: keyHotspots.map((hotspot) => ({
        label: hotspot.label || 'Hotspot',
        yaw: hotspot.yaw,
        pitch: hotspot.pitch,
        target: hotspot.target || key,
        sizePercent: hotspot.sizePercent,
        rotation: hotspot.rotation,
        targetFov: hotspot.targetFov,
        targetViewParameters: hotspot.targetViewParameters,
        sound: hotspot.sound
      }))
    });
  });

  if (fallbackKey && !entryMap.has(fallbackKey)) {
    entryMap.set(fallbackKey, fallbackEntry);
  }

  // Sort by sidebar list order so export order matches what the user sees.
  const sidebarRows = [...document.querySelectorAll('#files .file-name')];
  const sortedEntries = [...entryMap.values()].sort((a, b) => {
    const ai = sidebarRows.findIndex((r) => r.dataset.fileName === a.key);
    const bi = sidebarRows.findIndex((r) => r.dataset.fileName === b.key);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });

  return sortedEntries.length ? sortedEntries : [fallbackEntry];
}

async function addExposePageToZip(zip, exportTargets) {
  const threeResponse = await fetch('/node_modules/three/build/three.module.min.js');
  if (!threeResponse.ok) throw new Error('Failed to load Three.js for expose export');
  zip.file('app-files/three.min.js', await threeResponse.arrayBuffer());
  zip.file('app-files/expose.html', buildExposeHtml(exportTargets));
}

function buildExposeHtml(exportTargets = []) {
  const exposeItems = exportTargets.map((target) => ({
    label: target.label || target.key,
    preview: `${String(target.root || `tiles/${target.key}`).replace(/^\.\//, '').replace(/^app-files\//, '').replace(/\/$/, '')}/preview.jpg`
  }));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Expose - ${String(exposeItems.length)} scenes</title>
  <style>
    :root { font-family: Arial, sans-serif; color: #f4f5ef; background: #0c1012; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body { min-height: 100vh; overflow-x: hidden; background: radial-gradient(circle at 50% 0%, #28352f, #0c1012 58%); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 32px; border-bottom: 1px solid rgba(255,255,255,.12); }
    h1 { margin: 0; font-size: clamp(22px, 4vw, 42px); }
    p { margin: 6px 0 0; color: #9ba7a0; }
    #expose { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 22px; width: min(1200px, 100%); margin: auto; padding: 36px 28px 52px; }
    .scene-card { min-width: 0; padding: 18px 12px 14px; border: 1px solid rgba(255,255,255,.1); background: rgba(20,27,28,.72); text-align: center; }
    .sphere-host { height: 190px; }
    .sphere-host canvas { display: block; width: 100%; height: 100%; }
    .scene-label { overflow: hidden; color: #d8fa5a; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .empty { grid-column: 1 / -1; padding: 70px 20px; color: #9ba7a0; text-align: center; }
    @media (max-width: 600px) { header { padding: 20px; } #expose { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 20px 12px 32px; } .scene-card { padding: 10px 6px; } .sphere-host { height: 135px; } }
  </style>
</head>
<body>
  <header><div><h1>Expose</h1><p>All scenes from this export</p></div><span>${exposeItems.length} scenes</span></header>
  <main id="expose"></main>
  <script type="module">
    import * as THREE from './three.min.js';
    const items = ${JSON.stringify(exposeItems)};
    const host = document.querySelector('#expose');
    const viewers = [];
    function addSphere(item) {
      const card = document.createElement('article');
      card.className = 'scene-card';
      card.innerHTML = '<div class="sphere-host"></div><div class="scene-label"></div>';
      card.querySelector('.scene-label').textContent = item.label;
      host.appendChild(card);
      const sphereHost = card.querySelector('.sphere-host');
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#141b1c');
      const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
      camera.position.set(0, 0, 3.2);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      sphereHost.appendChild(renderer.domElement);
      scene.add(new THREE.HemisphereLight('#f2f5e8', '#172326', 2.5));
      const light = new THREE.DirectionalLight('#fff6d5', 2.8);
      light.position.set(2, 3, 4);
      scene.add(light);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.1, 64, 48), new THREE.MeshStandardMaterial({ color: '#fff', roughness: .82 }));
      scene.add(sphere);
      new THREE.TextureLoader().load(item.preview, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        sphere.material.map = texture;
        sphere.material.needsUpdate = true;
      });
      viewers.push({ scene, sphere, camera, renderer, host: sphereHost });
    }
    items.forEach(addSphere);
    if (!items.length) host.innerHTML = '<div class="empty">No scenes were exported.</div>';
    function resize(viewer) {
      const rect = viewer.host.getBoundingClientRect();
      viewer.camera.aspect = rect.width / Math.max(rect.height, 1);
      viewer.camera.updateProjectionMatrix();
      viewer.renderer.setSize(rect.width, rect.height, false);
    }
    function animate() {
      requestAnimationFrame(animate);
      viewers.forEach((viewer) => { resize(viewer); viewer.sphere.rotation.y += .012; viewer.sphere.rotation.x += .002; viewer.renderer.render(viewer.scene, viewer.camera); });
    }
    animate();
  </script>
</body>
</html>`;
}

async function addExportSoundsToZip(zip, exportTargets) {
  await Promise.all(exportTargets.flatMap((target) => (target.hotspots || []).map(async (hotspot, index) => {
    const sound = hotspot.sound;
    if (!sound?.url && !sound?.file) return;
    if (sound.path) {
      // Sound is from the original ZIP — read directly from archive instead of blob URL
      // (blob URLs can become invalid; reading from archive is always reliable)
      if (currentZipArchive) {
        const appRoot = 'app-files/';
        const entryPath = appRoot + sound.path;
        const entry = currentZipArchive.file(entryPath);
        if (entry) {
          const bytes = await entry.async('arraybuffer');
          const safeTarget = String(target.key || 'scene').replace(/[^a-z0-9_-]/gi, '_');
          const extension = (sound.name || sound.path.split('/').pop()).match(/\.[a-z0-9]+$/i)?.[0] || '.mp3';
          const newPath = `sounds/${safeTarget}/hotspot-${index + 1}${extension.toLowerCase()}`;
          zip.file(`app-files/${newPath}`, bytes);
          hotspot.sound = { url: newPath, name: sound.name || sound.path.split('/').pop(), loop: Boolean(sound.loop) };
          return;
        }
      }
      // Fallback: just reference the path (file will be copied from ZIP archive copy)
      hotspot.sound = { url: sound.path, name: sound.name || sound.path.split('/').pop(), loop: Boolean(sound.loop) };
      return;
    }
    const safeTarget = String(target.key || 'scene').replace(/[^a-z0-9_-]/gi, '_');
    const extension = (sound.name || sound.file?.name || 'sound.mp3').match(/\.[a-z0-9]+$/i)?.[0] || '.mp3';
    const path = `sounds/${safeTarget}/hotspot-${index + 1}${extension.toLowerCase()}`;
    let bytes;
    if (sound.file) {
      bytes = await sound.file.arrayBuffer();
    } else if (sound.url.startsWith('data:')) {
      bytes = Uint8Array.from(atob(sound.url.split(',')[1]), (c) => c.charCodeAt(0));
    } else {
      // blob: or http: URL — fetch from current context
      try {
        bytes = await (await fetch(sound.url)).arrayBuffer();
      } catch (e) {
        console.warn('Could not fetch hotspot sound:', sound.url, e);
        return;
      }
    }
    zip.file(`app-files/${path}`, bytes);
    hotspot.sound = { url: path, name: sound.name || sound.file?.name || path.split('/').pop(), loop: Boolean(sound.loop) };
  })));
  await Promise.all(exportTargets.map(async (target) => {
    const sound = target.sceneSound;
    if (!sound?.url && !sound?.file) return;
    if (sound.path) {
      target.sceneSound = { url: sound.path, name: sound.name || sound.path.split('/').pop(), loop: Boolean(sound.loop) };
      return;
    }
    const safeTarget = String(target.key || 'scene').replace(/[^a-z0-9_-]/gi, '_');
    const extension = (sound.name || sound.file?.name || 'page-sound.mp3').match(/\.[a-z0-9]+$/i)?.[0] || '.mp3';
    const path = `sounds/${safeTarget}/page-sound${extension.toLowerCase()}`;
    const bytes = sound.file
      ? await sound.file.arrayBuffer()
      : sound.url.startsWith('data:')
        ? Uint8Array.from(atob(sound.url.split(',')[1]), (character) => character.charCodeAt(0))
        : await (await fetch(sound.url)).arrayBuffer();
    zip.file(`app-files/${path}`, bytes);
    target.sceneSound = { url: path, name: sound.name || sound.file?.name || path.split('/').pop(), loop: Boolean(sound.loop) };
  }));
  await Promise.all(exportTargets.map(async (target) => {
    const video = target.sceneVideo;
    if (!video?.url && !video?.file) return;
    if (video.path) {
      target.sceneVideo = { url: video.path, name: video.name || video.path.split('/').pop() };
      return;
    }
    const safeTarget = String(target.key || 'scene').replace(/[^a-z0-9_-]/gi, '_');
    const extension = (video.name || video.file?.name || 'avatar.mp4').match(/\.[a-z0-9]+$/i)?.[0] || '.mp4';
    const path = `videos/${safeTarget}/avatar${extension.toLowerCase()}`;
    const bytes = video.file ? await video.file.arrayBuffer() : video.url.startsWith('data:')
      ? Uint8Array.from(atob(video.url.split(',')[1]), (character) => character.charCodeAt(0))
      : await (await fetch(video.url)).arrayBuffer();
    zip.file(`app-files/${path}`, bytes);
    target.sceneVideo = { url: path, name: video.name || video.file?.name || path.split('/').pop() };
  }));
}

function patchExportHotspotIndexJs(indexJs) {
  if (indexJs.includes('var hotspotScale = Math.min(2')) return indexJs;
  return indexJs.replace(
    "    wrapper.classList.add('link-hotspot');",
    "    wrapper.classList.add('link-hotspot');\n    var hotspotScale = Math.min(2, Math.max(0.5, Number(hotspot.sizePercent || 100) / 100));\n    var hotspotBaseSize = window.matchMedia && window.matchMedia('(max-width: 500px)').matches ? 70 : 60;\n    wrapper.style.setProperty('--hotspot-size', (hotspotBaseSize * hotspotScale) + 'px');\n    wrapper.dataset.sizePercent = String(hotspot.sizePercent || 100);"
  );
}

function patchExportSceneVideoIndexJs(indexJs) {
  const videoFunction = `  function playSceneVideo(scene) {
    if (activeSceneVideoButton) {
      activeSceneVideoButton.remove();
      activeSceneVideoButton = null;
    }
    if (activeSceneVideoWrap) {
      activeSceneVideo.pause();
      activeSceneVideoWrap.remove();
      activeSceneVideo = null;
      activeSceneVideoWrap = null;
    }
    if (!scene || !scene.data || !scene.data.sceneVideo || !scene.data.sceneVideo.url) return;
    var wrapper = document.createElement('div');
    wrapper.className = 'scene-avatar-video-wrap';
    activeSceneVideo = document.createElement('video');
    activeSceneVideo.className = 'scene-avatar-video';
    activeSceneVideo.src = scene.data.sceneVideo.url;
    activeSceneVideo.autoplay = false;
    activeSceneVideo.muted = false;
    activeSceneVideo.loop = false;
    activeSceneVideo.playsInline = true;
    activeSceneVideo.controls = false;
    var closeButton = document.createElement('button');
    closeButton.className = 'scene-avatar-video-close';
    closeButton.type = 'button';
    closeButton.textContent = 'X';
    function closeSceneVideo() {
      activeSceneVideo.pause();
      wrapper.remove();
      if (activeSceneVideoWrap === wrapper) {
        activeSceneVideo = null;
        activeSceneVideoWrap = null;
      }
      showSceneVideoButton(activeVideoScene);
    }
    closeButton.addEventListener('click', closeSceneVideo);
    activeSceneVideo.addEventListener('ended', closeSceneVideo, { once: true });
    var playButton = document.createElement('button');
    playButton.className = 'scene-avatar-video-play';
    playButton.type = 'button';
    playButton.setAttribute('aria-label', 'Play video');
    function updatePlayButton() {
      playButton.textContent = activeSceneVideo.paused ? '\u25B6' : '\u275A\u275A';
      playButton.setAttribute('aria-label', activeSceneVideo.paused ? 'Play video' : 'Pause video');
      wrapper.classList.toggle('is-playing', !activeSceneVideo.paused);
      wrapper.classList.toggle('is-playing', !activeSceneVideo.paused);
    }
    playButton.addEventListener('click', function(event) {
      event.stopPropagation();
      if (activeSceneVideo.paused) activeSceneVideo.play().catch(function() {});
      else activeSceneVideo.pause();
      updatePlayButton();
    });
    activeSceneVideo.addEventListener('play', updatePlayButton);
    activeSceneVideo.addEventListener('pause', updatePlayButton);
    activeSceneVideo.addEventListener('click', function() {
      if (activeSceneVideo.paused) activeSceneVideo.play().catch(function() {});
      else activeSceneVideo.pause();
    });
    activeSceneVideo.addEventListener('click', function() {
      if (activeSceneVideo.paused) activeSceneVideo.play().catch(function() {});
      else activeSceneVideo.pause();
    });
    updatePlayButton();
    var caption = document.createElement('div');
    caption.className = 'scene-avatar-video-caption';
    caption.textContent = 'KI-Inhalt';
    wrapper.appendChild(activeSceneVideo);
    wrapper.appendChild(caption);
    wrapper.appendChild(closeButton);
    wrapper.appendChild(playButton);
    activeSceneVideoWrap = wrapper;
    document.body.appendChild(wrapper);
  }
  function showSceneVideoButton(scene) {
    if (activeSceneVideoButton) {
      activeSceneVideoButton.remove();
      activeSceneVideoButton = null;
    }
    if (!scene || !scene.data || !scene.data.sceneVideo || !scene.data.sceneVideo.url) return;
    activeVideoScene = scene;
    activeSceneVideoButton = document.createElement('button');
    activeSceneVideoButton.type = 'button';
    activeSceneVideoButton.className = 'scene-video-reopen';
    activeSceneVideoButton.setAttribute('aria-label', 'Open scene video');
    activeSceneVideoButton.style.position = 'fixed';
    activeSceneVideoButton.style.top = '134px';
    activeSceneVideoButton.style.left = 'auto';
    activeSceneVideoButton.style.right = '18px';
    activeSceneVideoButton.style.bottom = 'auto';
     activeSceneVideoButton.style.width = '52px';
    activeSceneVideoButton.style.height = '52px';
    activeSceneVideoButton.style.padding = '0';
    activeSceneVideoButton.style.border = '2px solid rgba(255,255,255,0.95)';
    activeSceneVideoButton.style.borderRadius = '50%';
    activeSceneVideoButton.style.overflow = 'hidden';
    activeSceneVideoButton.style.background = '#111';
    activeSceneVideoButton.style.boxShadow = '0 8px 20px rgba(0,0,0,0.35)';
    activeSceneVideoButton.style.cursor = 'pointer';
    activeSceneVideoButton.style.zIndex = '21';
    activeSceneVideoButton.style.display = 'block';
    var previewVideo = document.createElement('video');
    previewVideo.src = scene.data.sceneVideo.url;
    previewVideo.muted = true;
    previewVideo.autoplay = true;
    previewVideo.loop = true;
    previewVideo.playsInline = true;
    previewVideo.style.display = 'block';
    previewVideo.style.width = '100%';
    previewVideo.style.height = '100%';
    previewVideo.style.objectFit = 'cover';
    previewVideo.style.border = '0';
    previewVideo.style.pointerEvents = 'none';
    previewVideo.setAttribute('aria-hidden', 'true');
    activeSceneVideoButton.appendChild(previewVideo);
    activeSceneVideoButton.addEventListener('click', function() { playSceneVideo(activeVideoScene); });
    document.body.appendChild(activeSceneVideoButton);
  }`;

  if (!indexJs.includes('function playSceneVideo(scene) {')) return indexJs;
  const withVideoState = indexJs.includes('var activeSceneVideoWrap')
    ? indexJs.replace('var activeSceneVideoWrap = null;', 'var activeSceneVideoWrap = null; var activeSceneVideoButton = null; var activeVideoScene = null;')
    : indexJs.includes('var activeSceneVideo = null;')
      ? indexJs.replace('var activeSceneVideo = null;', 'var activeSceneVideo = null;\n  var activeSceneVideoWrap = null;\n  var activeSceneVideoButton = null;\n  var activeVideoScene = null;')
      : indexJs.replace('function playSceneVideo(scene) {', 'var activeSceneVideo = null;\n  var activeSceneVideoWrap = null;\n  var activeSceneVideoButton = null;\n  var activeVideoScene = null;\n  function playSceneVideo(scene) {');
  const videoFunctionPattern = /function playSceneVideo\(scene\) \{[\s\S]*?\}\s*(?=function (?:playSceneSound|stopSceneSound|playHotspotSound)|var activeHotspotAudio)/g;
  const withoutVideoFunctions = withVideoState.replace(videoFunctionPattern, '');
  const videoAnchor = withoutVideoFunctions.includes('function playSceneSound(scene) {')
    ? 'function playSceneSound(scene) {'
    : withoutVideoFunctions.includes('function switchScene(scene, overrideView) {')
      ? 'function switchScene(scene, overrideView) {'
      : 'function switchScene(scene) {';
  const withVideoButton = withoutVideoFunctions.replace(videoAnchor, `${videoFunction}\n  ${videoAnchor}`);
  return withVideoButton.replace('playSceneVideo(scene);', 'activeVideoScene = scene; playSceneVideo(scene);');
}

function patchExportHotspotStyleCss(styleCss) {
  if (styleCss.includes('--hotspot-size')) return styleCss;
  return styleCss.replace(
    `  width: 60px;\n  height: 60px;\n  margin-left: -30px;\n  margin-top: -30px;`,
    `  --hotspot-size: 60px;\n  width: var(--hotspot-size);\n  height: var(--hotspot-size);\n  margin-left: calc(var(--hotspot-size) / -2);\n  margin-top: calc(var(--hotspot-size) / -2);`
  );
}

function patchExportAvatarStyleCss(styleCss) {
  const reopenCss = `
.scene-video-reopen {
  position: fixed;
  z-index: 21;
  top: 132px !important;
  right: 18px;
  bottom: auto;
  width: 52px;
  height: 52px;
  padding: 0;
  overflow: hidden;
  border: 2px solid #fff;
  border-radius: 50%;
  background: rgba(34, 132, 83, .92);
  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  cursor: pointer;
}
.scene-video-reopen video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  pointer-events: none;
}
.scene-video-reopen:hover {
  background: #2eaa6c;
}
@media (max-width: 600px) {
  .scene-video-reopen {
    top: 126px !important;
    right: 10px;
    width: 46px;
    height: 46px;
  }
}`;

  return `${styleCss}\n${reopenCss}`;
}

async function openExportPreview() {
  if (!currentFile && !panoramaFileGroups.size && !equirectSourceFiles.size) return;

  const previewBtn = document.querySelector('#preview-btn');
  previewBtn.disabled = true;
  previewBtn.textContent = 'Building preview...';

  try {
    // Build the exact same ZIP as export, then open its index.html inline.
    const zip = new JSZip();
    const sceneName = document.querySelector('#scene-name')?.textContent || 'scene';
    // Deep-clone only the sound/video fields so addExportSoundsToZip mutations
    // don't affect the live panoramaHotspots state (which would break playback after preview).
    const exportTargets = buildExportTargets().map((target) => ({
      ...target,
      sceneSound: target.sceneSound ? { ...target.sceneSound } : null,
      sceneVideo: target.sceneVideo ? { ...target.sceneVideo } : null,
      hotspots: (target.hotspots || []).map((h) => ({
        ...h,
        sound: h.sound ? { ...h.sound } : null,
      })),
    }));

    // ── copy ZIP archive files (if project was opened from a ZIP) ──────────
    if (currentZipArchive) {
      await Promise.all(
        Object.entries(currentZipArchive.files)
          .filter(([, e]) => !e.dir)
          .map(async ([path, entry]) => zip.file(path, await entry.async('arraybuffer')))
      );
    }

    // ── write tile files ───────────────────────────────────────────────────
    if (currentZipArchive) {
      // panoramaFileGroups tile folders (skip plain JPG duplicates)
      [...panoramaFileGroups.entries()].forEach(([key, files]) => {
        const canonicalKey = key.replace(/\.[^/.]+$/, '');
        if (equirectSourceFiles.has(canonicalKey)) return;
        const exportKey = currentZipExportTargets.some((t) => t.key === key) ? `${key}-folder` : key;
        files.forEach((file) => {
          const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
          const tileIndex = relative.split('/').findIndex((s) => isMarzipanoTileLevelSegment(s));
          const filePath = tileIndex > 0
            ? `app-files/tiles/${exportKey}/${relative.split('/').slice(tileIndex).join('/')}`
            : `app-files/tiles/${exportKey}/preview.jpg`;
          zip.file(filePath, file);
        });
      });

      // plain equirect JPGs added on top of ZIP
      const zipImportedKeys = new Set(currentZipExportTargets.map((t) => t.key));
      for (const [key, sourceFile] of equirectSourceFiles.entries()) {
        if (/\.[^/.]+$/.test(key)) continue;
        if (zipImportedKeys.has(key)) continue;
        if ([...panoramaFileGroups.keys()].includes(key)) continue;
        const target = exportTargets.find((t) => t.key === key);
        if (!target) continue;
        if (/\.jpe?g$/i.test(sourceFile.name)) {
          const generated = officialEquirectResults.get(sourceFile) || await generateOfficialEquirectTiles(sourceFile, {
            onProgress: (pct) => { previewBtn.textContent = `Building ${pct}%...`; }
          });
          officialEquirectResults.set(sourceFile, generated);
          target.geometryType = 'cube';
          target.faceSize = generated.faceSize;
          target.levels = generated.levels;
          const sizeToIndex = new Map(generated.levels.map((l, i) => [l.size, i + 1]));
          generated.tiles.forEach((tile) => {
            const li = sizeToIndex.get(tile.level?.size ?? tile.level) ?? 1;
            zip.file(`app-files/tiles/${key}/${li}/${tile.face}/${tile.y}/${tile.x}.jpg`, tile.data);
          });
          if (generated.preview) zip.file(`app-files/tiles/${key}/preview.jpg`, generated.preview);
        }
      }
    } else {
      const allFiles = [...panoramaFileGroups.values()].flat();
      if (allFiles.length) {
        allFiles.forEach((file) => {
          const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
          const segments = relative.split('/').filter(Boolean);
          const tli = segments.findIndex((s) => isMarzipanoTileLevelSegment(s));
          const folderName = tli > 0 ? (segments.slice(0, tli).at(-1) || getMarzipanoTileFolder(file)) : (getMarzipanoTileFolder(file) || 'panorama');
          const rel = tli > 0 ? segments.slice(tli).join('/') : (segments.slice(1).join('/') || file.name);
          zip.file(`app-files/tiles/${folderName}/${rel}`, file);
        });
      } else if (currentFile && /\.(jpe?g|png)$/i.test(currentFile.name)) {
        const equirectEntries = equirectSourceFiles.size
          ? [...equirectSourceFiles.entries()].filter(([k]) => !/\.[^/.]+$/.test(k))
          : [[getMarzipanoTileFolder(currentFile) || currentFile.name.replace(/\.[^/.]+$/, '') || 'panorama', currentFile]];
        for (const [sceneKey, sourceFile] of equirectEntries) {
          const sceneTarget = exportTargets.find((t) => t.key === sceneKey);
          if (!sceneTarget) continue;
          const generated = officialEquirectResults.get(sourceFile) || await generateOfficialEquirectTiles(sourceFile, {
            onProgress: (pct) => { previewBtn.textContent = `Building ${pct}%...`; }
          });
          officialEquirectResults.set(sourceFile, generated);
          sceneTarget.geometryType = 'cube';
          sceneTarget.faceSize = generated.faceSize;
          sceneTarget.levels = generated.levels;
          const sizeToIndex = new Map(generated.levels.map((l, i) => [l.size, i + 1]));
          generated.tiles.forEach((tile) => {
            const li = sizeToIndex.get(tile.level?.size ?? tile.level) ?? 1;
            zip.file(`app-files/tiles/${sceneKey}/${li}/${tile.face}/${tile.y}/${tile.x}.jpg`, tile.data);
          });
          if (generated.preview) zip.file(`app-files/tiles/${sceneKey}/preview.jpg`, generated.preview);
        }
      }
    }

    // ── write data.js + template files ────────────────────────────────────
    // For preview: resolve media files to blob URLs directly without writing to ZIP,
    // so large video files don't need to be base64-encoded into the HTML.
    exportTargets.forEach((target) => {
      if (target.sceneVideo?.file && !target.sceneVideo.url) {
        target.sceneVideo = { ...target.sceneVideo, url: URL.createObjectURL(target.sceneVideo.file) };
      }
      if (target.sceneSound?.file && !target.sceneSound.url) {
        target.sceneSound = { ...target.sceneSound, url: URL.createObjectURL(target.sceneSound.file) };
      }
      if (target.sceneSound?.url?.startsWith('blob:')) {
        // Keep blob URL as-is — addExportSoundsToZip will fetch and write it to ZIP
      }
      (target.hotspots || []).forEach((hotspot) => {
        if (hotspot.sound?.file && !hotspot.sound.url) {
          hotspot.sound = { ...hotspot.sound, url: URL.createObjectURL(hotspot.sound.file) };
        }
      });
    });
    await addExportSoundsToZip(zip, exportTargets);
    zip.file('app-files/data.js', buildMarzipanoDataJs(exportTargets));
    zip.file('app-files/chat.js', buildExportChatScript(exportTargets[0]?.projectDetails || {}));
    await addBundledMarzipanoTemplate(zip);
    const templateIndexResponse = await fetch('/marzipano-template/app-files/index.html');
    const templateIndexHtml = templateIndexResponse.ok ? await templateIndexResponse.text() : buildStandaloneMarzipanoIndexHtml(exportTargets);
    const updatedIndexHtml = buildMarzipanoIndexHtml(templateIndexHtml, exportTargets).replace('</body>', '<script src="chat.js"></script>\n</body>');
    zip.file('app-files/index.html', updatedIndexHtml);
    const templateIndexJsResponse = await fetch('/marzipano-template/app-files/index.js');
    if (templateIndexJsResponse.ok) {
      zip.file('app-files/index.js', patchExportSceneVideoIndexJs(patchExportHotspotIndexJs(await templateIndexJsResponse.text())));
    }
    const templateStyleResponse = await fetch('/marzipano-template/app-files/style.css');
    if (templateStyleResponse.ok) {
      zip.file('app-files/style.css', patchExportAvatarStyleCss(patchExportHotspotStyleCss(await templateStyleResponse.text())));
    }

    // ── build self-contained HTML from the ZIP ────────────────────────────
    // Read all files from the ZIP and build a single HTML that inlines
    // everything as data URLs, so it works as a blob document.
    const zipFiles = zip.files;

    // Read all binary assets and build a lookup: normalized path → data URL or raw text
    const assetMap = {};
    const textExts = new Set(['js', 'css', 'html', 'txt']);
    // Video/audio files are large — use blob URLs instead of base64 to avoid memory issues.
    const blobExts = new Set(['mp4', 'webm', 'mp3', 'ogg', 'wav', 'm4a', 'aac']);
    const blobUrls = []; // track for cleanup (not needed since page will be closed)

    await Promise.all(
      Object.entries(zipFiles)
        .filter(([, e]) => !e.dir)
        .map(async ([path]) => {
          const normalized = path.replace(/^app-files\//, '');
          const ext = path.split('.').pop().toLowerCase();
          const mime = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            js: 'text/javascript', css: 'text/css', html: 'text/html',
            mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
            ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac'
          }[ext] || 'application/octet-stream';

          if (blobExts.has(ext)) {
            // Large binary files: use blob URL to avoid base64 memory overhead
            const data = await zipFiles[path].async('uint8array');
            const blobUrl = URL.createObjectURL(new Blob([data], { type: mime }));
            blobUrls.push(blobUrl);
            assetMap[normalized] = blobUrl;
          } else if (textExts.has(ext)) {
            // Text files: UTF-8 safe base64 encoding
            const text = await zipFiles[path].async('string');
            const bytes = new TextEncoder().encode(text);
            let binary = '';
            bytes.forEach((b) => { binary += String.fromCharCode(b); });
            assetMap[normalized] = `data:${mime};charset=utf-8;base64,${btoa(binary)}`;
          } else {
            // Other binary files (images): standard base64
            const data = await zipFiles[path].async('uint8array');
            let binary = '';
            data.forEach((b) => { binary += String.fromCharCode(b); });
            assetMap[normalized] = `data:${mime};base64,${btoa(binary)}`;
          }
        })
    );

    // Get the main index.html and inline all its resources
    const indexEntry = zipFiles['app-files/index.html'];
    let indexHtml = await indexEntry.async('string');

    const assetMapJson = JSON.stringify(assetMap);

    // Inline CSS
    // Helper: decode a data URL back to UTF-8 string (handles multi-byte chars correctly)
    const decodeText = (dataUrl) => {
      const b64 = dataUrl.split(',')[1];
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    };

    indexHtml = indexHtml.replace(/<link[^>]+href="([^"]+\.css)"[^>]*>/g, (match, href) => {
      const key = href.replace(/^\.\//, '');
      if (!assetMap[key]) return match;
      return `<style>${decodeText(assetMap[key])}</style>`;
    });

    // Replace img src (icons etc.)
    indexHtml = indexHtml.replace(/src="(img\/[^"]+)"/g, (match, src) => {
      return assetMap[src] ? `src="${assetMap[src]}"` : match;
    });

    // Inline vendor/marzipano.js — inject the patch immediately after
    indexHtml = indexHtml.replace(
      /<script[^>]+src="([^"]*vendor\/marzipano\.js)"[^>]*><\/script>/,
      (match, src) => {
        const key = src.replace(/^\.\//, '');
        if (!assetMap[key]) return match;
        const marzJs = decodeText(assetMap[key]);
        // Patch fromString to serve tiles from assetMap data URLs
        const patch = `
(function(){
  var __am=${assetMapJson};
  Marzipano.ImageUrlSource.fromString=function(tpl,opts){
    return new Marzipano.ImageUrlSource(function(tile){
      var u=tpl.replace('{z}',tile.z).replace('{f}',tile.face).replace('{y}',tile.y).replace('{x}',tile.x);
      u=u.replace(/^\\.\\//, '');
      if(__am[u]) return {url:__am[u]};
      var prev=opts&&opts.cubeMapPreviewUrl;
      if(prev){var pk=prev.replace(/^\\.\\//, ''); if(__am[pk]) return {url:__am[pk]};}
      return {url:''};
    });
  };
})();`;
        return `<script>${marzJs}${patch}</script>`;
      }
    );

    // Inline remaining JS files (data.js, vendor/*.js except marzipano already done, index.js)
    indexHtml = indexHtml.replace(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/g, (match, src) => {
      const key = src.replace(/^\.\//, '');
      if (!assetMap[key]) return match;
      return `<script>${decodeText(assetMap[key])}</script>`;
    });

    // Patch image paths hardcoded in JavaScript (e.g. icon.src = 'img/link.png')
    // These are inside inlined script content so HTML attribute replace won't catch them.
    ['img/link.png', 'img/info.png', 'img/close.png', 'img/fullscreen.png',
     'img/windowed.png', 'img/up.png', 'img/down.png', 'img/left.png', 'img/right.png',
     'img/plus.png', 'img/minus.png', 'img/play.png', 'img/pause.png'].forEach((imgPath) => {
      if (assetMap[imgPath]) {
        // Replace both 'img/xxx' and "img/xxx" occurrences in JS strings
        indexHtml = indexHtml.split(`'${imgPath}'`).join(`'${assetMap[imgPath]}'`);
        indexHtml = indexHtml.split(`"${imgPath}"`).join(`"${assetMap[imgPath]}"`);
      }
    });

    // Patch APP_DATA to replace relative video/sound URLs with data URLs from assetMap.
    // Inject BEFORE index.js so when index.js's load handler fires, URLs are already patched.
    const mediaPatch = `
(function(){
  var __am=${assetMapJson};
  function fixUrl(url){ if(!url) return url; var k=url.replace(/^\\.?\\//, ''); return __am[k]||url; }
  window.addEventListener('DOMContentLoaded', function(){
    if(!window.APP_DATA||!APP_DATA.scenes) return;
    APP_DATA.scenes.forEach(function(s){
      if(s.sceneVideo) s.sceneVideo.url=fixUrl(s.sceneVideo.url);
      if(s.sceneSound) s.sceneSound.url=fixUrl(s.sceneSound.url);
      (s.linkHotspots||[]).forEach(function(h){ if(h.sound) h.sound.url=fixUrl(h.sound.url); });
    });
  });
})();`;

    // Insert media patch right after the last data.js script tag and before index.js
    indexHtml = indexHtml.replace(
      /<script>var APP_DATA/,
      `<script>${mediaPatch}<\/script><script>var APP_DATA`
    );

    const blob = new Blob([indexHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();

  } catch (err) {
    console.error('Preview failed', err);
    alert('Preview failed: ' + (err?.message || err));
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview';
  }
}

async function exportScene() {
  if (!currentFile && !panoramaFileGroups.size) return;
  if (!window.confirm('Export the current tour?\nThe exported ZIP file will be downloaded.')) return;

  try {
    const zip = new JSZip();
    const exportBtn = document.querySelector('#export-btn');
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';

    const sceneName = document.querySelector('#scene-name').textContent;
    const exportTargets = buildExportTargets().map((target) => ({
      ...target,
      sceneSound: target.sceneSound ? { ...target.sceneSound } : null,
      sceneVideo: target.sceneVideo ? { ...target.sceneVideo } : null,
      hotspots: (target.hotspots || []).map((h) => ({
        ...h,
        sound: h.sound ? { ...h.sound } : null,
      })),
    }));

    if (currentZipArchive) {
      await Promise.all(Object.entries(currentZipArchive.files).filter(([, entry]) => !entry.dir).map(async ([path, entry]) => {
        zip.file(path, await entry.async('arraybuffer'));
      }));
      [...panoramaFileGroups.entries()].forEach(([key, files]) => {
        // Skip plain JPG entries tracked in equirectSourceFiles — handled separately below.
        const canonicalKey = key.replace(/\.[^/.]+$/, '');
        if (equirectSourceFiles.has(canonicalKey)) return;

        const exportKey = currentZipExportTargets.some((target) => target.key === key) ? `${key}-folder` : key;
        files.forEach((file) => {
          const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
          const tileIndex = relative.split('/').findIndex((segment) => isMarzipanoTileLevelSegment(segment));
          const filePath = tileIndex > 0
            ? `app-files/tiles/${exportKey}/${relative.split('/').slice(tileIndex).join('/')}`
            : `app-files/tiles/${exportKey}/preview.jpg`;
          zip.file(filePath, file);
        });
      });

      // Also tile any plain equirect JPGs that were added on top of the ZIP project.
      const zipImportedKeys = new Set(currentZipExportTargets.map((t) => t.key));
      for (const [key, sourceFile] of equirectSourceFiles.entries()) {
        if (/\.[^/.]+$/.test(key)) continue; // skip full-filename duplicates
        if (zipImportedKeys.has(key)) continue; // already part of original ZIP
        if ([...panoramaFileGroups.keys()].includes(key)) continue; // handled above

        const target = exportTargets.find((t) => t.key === key);
        if (!target) continue;

        if (/\.jpe?g$/i.test(sourceFile.name)) {
          showProgress(`Processing ${key}...`, 20);
          const generated = officialEquirectResults.get(sourceFile) || await generateOfficialEquirectTiles(sourceFile, {
            onProgress: (pct) => showProgress(`Processing ${key}... ${pct}%`, pct),
          });
          officialEquirectResults.set(sourceFile, generated);

          target.geometryType = 'cube';
          target.faceSize = generated.faceSize;
          target.levels = generated.levels;

          const sizeToIndex = new Map(generated.levels.map((lvl, i) => [lvl.size, i + 1]));
          generated.tiles.forEach((tile) => {
            const levelSize = tile.level?.size ?? tile.level;
            const levelIndex = sizeToIndex.get(levelSize) ?? 1;
            zip.file(`app-files/tiles/${key}/${levelIndex}/${tile.face}/${tile.y}/${tile.x}.jpg`, tile.data);
          });
          if (generated.preview) zip.file(`app-files/tiles/${key}/preview.jpg`, generated.preview);
        } else {
          zip.file(`app-files/tiles/${key}/preview.jpg`, sourceFile);
        }
      }
      await addExportSoundsToZip(zip, exportTargets);
      zip.file('app-files/data.js', buildMarzipanoDataJs(exportTargets));
      const originalIndexHtml = await currentZipArchive.file('app-files/index.html').async('string');
      const updatedIndexHtml = buildMarzipanoIndexHtml(originalIndexHtml, exportTargets).replace('</body>', '<script src="chat.js"></script>\n</body>');
      zip.file('app-files/index.html', updatedIndexHtml);
      zip.file('app-files/chat.js', buildExportChatScript());
      const originalIndexJsFile = currentZipArchive.file('app-files/index.js');
      if (originalIndexJsFile) {
        const originalIndexJs = await originalIndexJsFile.async('string');
        let updatedIndexJs = patchExportSceneVideoIndexJs(patchExportHotspotIndexJs(originalIndexJs));
        zip.file('app-files/index.js', updatedIndexJs);
      }
      await addExposePageToZip(zip, exportTargets);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(sceneName || 'marzipano_export').replace(/[^a-z0-9]/gi, '_')}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export';
      return;
    }

    const allFiles = [...panoramaFileGroups.values()].flat();
    if (allFiles.length) {
      allFiles.forEach((file) => {
        const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
        const segments = relative.split('/').filter(Boolean);
        const tileLevelIndex = segments.findIndex((segment) => isMarzipanoTileLevelSegment(segment));
        const folderName = tileLevelIndex > 0
          ? (segments.slice(0, tileLevelIndex).at(-1) || getMarzipanoTileFolder(file) || 'panorama')
          : (getMarzipanoTileFolder(file) || 'panorama');
        const relativeToRoot = tileLevelIndex > 0
          ? segments.slice(tileLevelIndex).join('/')
          : segments.slice(1).join('/') || file.name;
        const zipPath = `app-files/tiles/${folderName}/${relativeToRoot}`;
        zip.file(zipPath, file);
      });
    } else if (currentMarzipanoFiles.length) {
      currentMarzipanoFiles.forEach((file) => {
        const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
        const segments = relative.split('/').filter(Boolean);
        const tileLevelIndex = segments.findIndex((segment) => isMarzipanoTileLevelSegment(segment));
        const folderName = getMarzipanoTileFolder(currentFile) || 'panorama';
        const relativeToRoot = tileLevelIndex > 0
          ? segments.slice(tileLevelIndex).join('/')
          : segments.slice(1).join('/') || file.name;
        const zipPath = `app-files/tiles/${folderName}/${relativeToRoot}`;
        zip.file(zipPath, file);
      });
    } else if (currentFile && /\.(jpe?g|png)$/i.test(currentFile.name) && currentFileType !== 'zip') {
      // Export all plain equirectangular JPGs that were loaded (not just currentFile).
      // equirectSourceFiles maps scene-key → original File for every loaded plain JPG.
      const equirectEntries = equirectSourceFiles.size
        ? [...equirectSourceFiles.entries()].filter(([key]) => !/\.[^/.]+$/.test(key))
        : [[getMarzipanoTileFolder(currentFile) || currentFile.name.replace(/\.[^/.]+$/, '') || 'panorama', currentFile]];

      for (const [sceneKey, sourceFile] of equirectEntries) {
        const sceneTarget = exportTargets.find((target) => target.key === sceneKey);
        if (!sceneTarget) continue;

        if (/\.jpe?g$/i.test(sourceFile.name)) {
          showProgress(`Processing ${sceneKey}... 0%`, 20);
          const generated = officialEquirectResults.get(sourceFile) || await generateOfficialEquirectTiles(sourceFile, {
            onProgress: (pct) => showProgress(`Processing ${sceneKey}... ${pct}%`, pct),
          });
          officialEquirectResults.set(sourceFile, generated);

          sceneTarget.geometryType = 'cube';
          sceneTarget.faceSize = generated.faceSize;
          sceneTarget.levels = generated.levels;

          const sizeToIndex = new Map(
            generated.levels.map((lvl, i) => [lvl.size, i + 1])
          );
          generated.tiles.forEach((tile) => {
            const levelSize = tile.level?.size ?? tile.level;
            const levelIndex = sizeToIndex.get(levelSize) ?? 1;
            zip.file(`app-files/tiles/${sceneKey}/${levelIndex}/${tile.face}/${tile.y}/${tile.x}.jpg`, tile.data);
          });
          if (generated.preview) zip.file(`app-files/tiles/${sceneKey}/preview.jpg`, generated.preview);
        } else {
          // PNG or other — store as equirect preview only
          zip.file(`app-files/tiles/${sceneKey}/preview.jpg`, sourceFile);
        }
      }
    }

    const marzipanoScript = await fetch('/node_modules/marzipano/dist/marzipano.js').then((response) => response.text()).catch(() => '');
    const exportTileUrlMap = buildExportTileUrlMap(exportTargets, allFiles.length ? allFiles : currentMarzipanoFiles);
    await addBundledMarzipanoTemplate(zip);
    if (currentZipLinkIconUrl) {
      const iconResponse = await fetch(currentZipLinkIconUrl);
      zip.file('app-files/img/link.png', await iconResponse.blob());
      exportTileUrlMap.__hotspotIcon = './img/link.png';
    }
    await addExportSoundsToZip(zip, exportTargets);
    zip.file('app-files/data.js', buildMarzipanoDataJs(exportTargets));
    const templateIndexResponse = await fetch('/marzipano-template/app-files/index.html');
    const templateIndexHtml = templateIndexResponse.ok ? await templateIndexResponse.text() : buildStandaloneMarzipanoIndexHtml(exportTargets);
    const updatedTemplateIndexHtml = buildMarzipanoIndexHtml(templateIndexHtml, exportTargets).replace('</body>', '<script src="chat.js"></script>\n</body>');
    zip.file('app-files/index.html', updatedTemplateIndexHtml);
    zip.file('app-files/chat.js', buildExportChatScript());
    const templateIndexJsResponse = await fetch('/marzipano-template/app-files/index.js');
    if (templateIndexJsResponse.ok) {
      const templateIndexJs = await templateIndexJsResponse.text();
      zip.file('app-files/index.js', patchExportSceneVideoIndexJs(patchExportHotspotIndexJs(templateIndexJs)));
    }
    const templateStyleResponse = await fetch('/marzipano-template/app-files/style.css');
    if (templateStyleResponse.ok) {
      const templateStyle = await templateStyleResponse.text();
      zip.file('app-files/style.css', patchExportAvatarStyleCss(patchExportHotspotStyleCss(templateStyle)));
    }
    await addExposePageToZip(zip, exportTargets);

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (sceneName || 'scene').replace(/[^a-z0-9]/gi, '_');
    a.download = safeName + '.zip';
    a.click();
    URL.revokeObjectURL(url);

    exportBtn.disabled = false;
    exportBtn.textContent = 'Export';
  } catch (err) {
    console.error('Export error:', err);
    alert('Export failed.');
    document.querySelector('#export-btn').disabled = false;
  }
}

const fileInput = document.querySelector('#file-input');
const headerFileTrigger = document.querySelector('#header-file-trigger');
const newProjectButton = document.querySelector('#new-project-btn');

newProjectButton?.addEventListener('click', () => {
  if (!window.confirm('Start a new project? All current scenes and changes will be cleared.')) return;
  resetAllState();
});

headerFileTrigger?.addEventListener('click', () => fileInput?.click());

const attachHeaderDropHandlers = (trigger, isFolder) => {
  if (!trigger) return;

  trigger.addEventListener('dragover', (event) => {
    event.preventDefault();
    trigger.classList.add('is-dragging');
  });

  trigger.addEventListener('dragleave', () => {
    trigger.classList.remove('is-dragging');
  });

  trigger.addEventListener('drop', (event) => {
    event.preventDefault();
    trigger.classList.remove('is-dragging');
    const files = event.dataTransfer?.files || [];
    if (files.length) addFiles(files, isFolder);
  });
};

attachHeaderDropHandlers(headerFileTrigger, false);

fileInput?.addEventListener('change', (event) => {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;

  const hasExistingContent = document.querySelector('#files .file-item') !== null;
  if (hasExistingContent) {
    if (!window.confirm('Opening a new project will clear all current scenes. Continue?')) return;
    resetAllState();
  }
  addFiles(files);
});

// Sidebar "Add scene" button — accepts 3D models and images (not ZIP)
const sidebarAddSceneInput = document.querySelector('#sidebar-add-scene-input');
sidebarAddSceneInput?.addEventListener('change', (event) => {
  addFiles(event.target.files || []);
  event.target.value = '';
});
document.querySelector('#export-btn').addEventListener('click', exportScene);
document.querySelector('#preview-btn').addEventListener('click', openExportPreview);
document.querySelector('#project-details-btn').addEventListener('click', editProjectDetails);
document.querySelector('#add-hotspot-btn').addEventListener('click', () => {
  hotspotPlacementMode = !hotspotPlacementMode;
  const btn = document.querySelector('#add-hotspot-btn');
  btn.classList.toggle('is-active', hotspotPlacementMode);
  btn.textContent = hotspotPlacementMode ? 'Click to place' : '+ Hotspot';
  status.textContent = hotspotPlacementMode ? 'Click on the panorama to place a hotspot' : '';
});
panoramaHost.addEventListener('click', (event) => {
  if (!hotspotPlacementMode || !activePanoramaScene) return;
  const target = event.target.closest('.hotspot-object');
  if (target) return;
  const next = getCoordsFromPointerEvent(event);
  addHotspotAtPosition(next.yaw, next.pitch, `Hotspot ${((panoramaHotspots.get(currentPanoramaKey()) || []).length + 1)}`);
  hotspotPlacementMode = false;
  const btn = document.querySelector('#add-hotspot-btn');
  btn.classList.remove('is-active');
  btn.textContent = '+ Hotspot';
  status.textContent = 'Hotspot added';
  setTimeout(() => { status.textContent = ''; }, 1200);
});

function animate() {
  requestAnimationFrame(animate);
  if (activeModel === defaultModel) { core.rotation.y += .004; ring.rotation.z += .002; ring2.rotation.z -= .003; }
  controls.update();
  renderer.render(scene, camera);
}
animate();

export { app };
