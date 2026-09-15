import './app.js';

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
    }
    if (!exportTargets.length && appDataPath) {
      const appDataText = await zipFiles.get(appDataPath).async('string');
      const appDataStart = appDataText.indexOf('{');
      const appDataEnd = appDataText.lastIndexOf('}');
      if (appDataStart >= 0 && appDataEnd > appDataStart) {
        const appData = JSON.parse(appDataText.slice(appDataStart, appDataEnd + 1));
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
    if (exportTargets.length > 1) addZipSceneItems(file, exportTargets);
    currentZipSceneKey = firstTarget.key;
    const panoramaKey = String(firstTarget.key || file.name.replace(/\.[^/.]+$/, '') || 'marzipano-export');
    const tileRoot = normalizeRelativePath(firstTarget.root || `./tiles/${panoramaKey}`).replace(/^\.\//, '').replace(/\/$/, '');

    const previewEntry = [...zipFiles.keys()].find((path) => /(^|\/)preview\.(jpe?g|png)$/i.test(path)) || [...zipFiles.keys()].find((path) => /\.(jpe?g|png)$/i.test(path));
    const previewUrl = previewEntry ? await blobUrlFromZipEntry(zip, previewEntry) : '';

    const tileUrlMap = new Map();
    [...zipFiles.keys()].filter((path) => /\.(jpe?g|png)$/i.test(path)).forEach(async (path) => {
      tileUrlMap.set(path, await blobUrlFromZipEntry(zip, path));
    });

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

    const localRoot = await resolveLocalMarzipanoTiles(file);
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

    const source = usesUploadedFiles
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
        : new Marzipano.ImageUrlSource(() => ({ url: URL.createObjectURL(file) }));

    const geometry = usesUploadedFiles || localRoot
      ? new Marzipano.CubeGeometry(tileLevels)
      : new Marzipano.EquirectGeometry([
          { tileSize: 1024, size: 1024 },
          { tileSize: 1024, size: 2048 }
        ]);

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
    document.querySelector('#scene-meta').textContent = (usesUploadedFiles || localRoot) ? 'PANORAMA / LOCAL TILES' : 'PANORAMA / EQUIRECTANGULAR';
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
    frameModel(activeModel);
    camera.fov = 38;
    camera.updateProjectionMatrix();
    controls.enablePan = true;
    currentFile = file;
    currentFileType = extension;
    document.querySelector('#export-btn').style.display = 'inline-block';
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
let currentZipSceneKey = null;
let currentZipLinkIconUrl = '';
let currentZipArchive = null;
let currentZipExportTargets = [];
let currentZipPreviewTileMap = {};
let currentZipPreviewUrls = new Map();
const deletedZipScenes = new WeakMap();
let sceneViewSettings = new Map();
let sceneSounds = new Map();
let sceneVideos = new Map();
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
  document.querySelector('#add-hotspot-btn').style.display = 'none';
  document.querySelector('#scene-name').textContent = 'Studio preview';
  document.querySelector('#scene-meta').textContent = 'DEFAULT SCENE / 01';
  status.textContent = '';
}

function removeSceneItem(item, file, sceneKey, isZipScene) {
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
    sceneTitles.delete(sceneKey);
  }

  item.remove();
  document.querySelector('#file-count').textContent = String(document.querySelector('#files').children.length).padStart(2, '0');
  if (isActive) resetViewerAfterDelete();
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
    previewImage.style.transform = `translateX(${yaw * 18}px) translateY(${-pitch * 18}px) scale(1.15)`;
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
      yawInput.value = (startYaw + (moveEvent.clientX - startX) / rect.width * Math.PI * 2).toFixed(2);
      pitchInput.value = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, startPitch - (moveEvent.clientY - startY) / rect.height * Math.PI)).toFixed(2);
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
    const soundUrl = file ? URL.createObjectURL(file) : currentSound?.url;
    if (!soundUrl) return;
    previewAudio = new Audio(soundUrl);
    previewAudio.loop = soundModeInput.value === 'loop';
    previewAudio.play().catch(() => {});
  });
  const close = (save) => {
    if (save) {
      const settings = { yaw: Number(yawInput.value) || 0, pitch: Number(pitchInput.value) || 0 };
      sceneViewSettings.set(sceneKey, settings);
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
  return keys;
}

function getScenePreviewUrl(key) {
  if (currentZipPreviewUrls.has(key)) return currentZipPreviewUrls.get(key);
  const files = panoramaFileGroups.get(key) || [];
  const previewFile = files.find((file) => isPreviewFile(file)) || files.find((file) => /\.(jpe?g|png)$/i.test(file.name));
  return previewFile ? URL.createObjectURL(previewFile) : '';
}

function createTargetPreviewViewer(key, host, image) {
  if (!currentZipPreviewUrls.has(key) && !Object.keys(currentZipPreviewTileMap).some((path) => path.startsWith(`${key}/`))) {
    image.src = getScenePreviewUrl(key);
    image.style.display = 'block';
    return null;
  }
  image.style.display = 'none';
  const previewUrl = currentZipPreviewUrls.get(key) || getScenePreviewUrl(key);
  const viewer = new Marzipano.Viewer(host, { stage: { progressive: true } });
  const source = new Marzipano.ImageUrlSource((tile) => {
    const level = Number(tile.z || 0);
    const face = String(tile.face || '').toLowerCase();
    const row = Number(tile.y || 0);
    const column = Number(tile.x || 0);
    if (level === 0 && previewUrl) {
      const faceIndex = 'bdflru'.indexOf(face);
      if (faceIndex >= 0) return { url: previewUrl, rect: { x: 0, y: faceIndex / 6, width: 1, height: 1 / 6 } };
    }
    const paths = [`${key}/${level}/${face}/${row}/${column}.jpg`, `${key}/${level}/${face}/${row}/${column}.png`];
    const path = paths.find((candidate) => currentZipPreviewTileMap[candidate]);
    return { url: path ? currentZipPreviewTileMap[path] : previewUrl };
  });
  const view = new Marzipano.RectilinearView({ yaw: 0, pitch: 0, fov: 120 * Math.PI / 180 });
  const scene = viewer.createScene({ source, geometry: new Marzipano.CubeGeometry([{ tileSize: 256, size: 256, fallbackOnly: true }, { tileSize: 512, size: 512 }, { tileSize: 512, size: 1024 }]), view, pinFirstLevel: true });
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
      <div class="hotspot-dialog-actions"><button type="button" class="hotspot-cancel">Cancel</button><button type="submit" class="hotspot-confirm">OK</button></div>
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
    const soundUrl = soundFile ? URL.createObjectURL(soundFile) : hotspot.sound?.url;
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
    const close = async (accepted) => {
      if (accepted) {
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
          hotspot.sound = { url: await readFileAsDataUrl(soundFile), name: soundFile.name, loop: soundModeInput.value === 'loop' };
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
      const view = sceneViewSettings.get(target.key) || { yaw: target.yaw || 0, pitch: target.pitch || 0 };
      return {
        ...target,
        label: getSceneTitle(target.key, target.label),
        exportSource: 'zip',
        yaw: view.yaw,
        pitch: view.pitch,
        initialViewParameters: {
          yaw: Number(view.yaw) || 0,
          pitch: Number(view.pitch) || 0,
          fov: Number(target.fov) || Math.PI / 2
        },
        sceneSound: sceneSounds.get(target.key) || target.sceneSound || null,
        sceneVideo: sceneVideos.get(target.key) || target.sceneVideo || null,
        hotspots: panoramaHotspots.get(target.key) || target.hotspots || []
      };
    });
    const importedKeys = new Set(importedTargets.map((target) => target.key));
    const addedTargets = [...panoramaFileGroups.entries()]
      .map(([key, files]) => ({
        key: importedKeys.has(key) ? `${key}-folder` : key,
        label: getSceneTitle(key, key),
        exportSource: 'folder',
        root: `./tiles/${importedKeys.has(key) ? `${key}-folder` : key}`,
        previewUrl: `./tiles/${importedKeys.has(key) ? `${key}-folder` : key}/preview.jpg`,
        geometryType: 'equirect',
        yaw: 0,
        pitch: 0,
        hotspots: panoramaHotspots.get(key) || []
      }));
    const targets = [...importedTargets, ...addedTargets];
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
    const viewState = sceneViewSettings.get(key) || ((key === currentKey && activePanoramaScene?.view)
      ? getViewAngles(activePanoramaScene.view())
      : currentPanoramaViewState);

    return {
      key,
      label: getSceneTitle(key, key),
      root: `./tiles/${key}`,
      previewUrl: `./tiles/${key}/preview.jpg`,
      geometryType: 'cube',
      yaw: viewState.yaw,
      pitch: viewState.pitch,
      initialViewParameters: {
        yaw: Number(viewState.yaw) || 0,
        pitch: Number(viewState.pitch) || 0,
        fov: Math.PI / 2
      },
      sceneSound: sceneSounds.get(key) || null,
      sceneVideo: sceneVideos.get(key) || null,
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
  const fallbackEntry = {
    key: fallbackKey,
    label: getMarzipanoTileFolder(currentFile) || currentFile?.name || 'panorama',
    root: `./tiles/${fallbackKey}`,
    previewUrl: `./tiles/${fallbackKey}/preview.jpg`,
    geometryType: panoramaFileGroups.size ? 'cube' : 'equirect',
    yaw: currentPanoramaViewState.yaw,
    pitch: currentPanoramaViewState.pitch,
    initialViewParameters: {
      yaw: Number(currentPanoramaViewState.yaw) || 0,
      pitch: Number(currentPanoramaViewState.pitch) || 0,
      fov: Math.PI / 2
    },
    sceneSound: sceneSounds.get(fallbackKey) || null,
    sceneVideo: sceneVideos.get(fallbackKey) || null,
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
  if (fallbackKey && !entryMap.has(fallbackKey)) {
    entryMap.set(fallbackKey, fallbackEntry);
  }

  return entryMap.size ? [...entryMap.values()] : [fallbackEntry];
}

function buildExportHtml(exportTargets, sceneName, tileUrlMap = {}, marzipanoScript = '', scriptMode = 'inline') {
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
            const candidates = [
              tile.z + '/' + tile.face + '/' + tile.y + '/' + tile.x + '.jpg',
              tile.z + '/' + tile.face + '/' + tile.y + '/' + tile.x + '.png',
              tile.z + '/' + tile.face + '/' + tile.y + '/' + tile.x + '.jpeg'
            ];
            const url = candidates.map((key) => tileUrlMap[key]).find(Boolean);
            return { url: url || item.previewUrl || '' };
          });
          geometry = new Marzipano.CubeGeometry([
            { tileSize: 256, size: 256, fallbackOnly: true },
            { tileSize: 512, size: 512 },
            { tileSize: 512, size: 1024 },
            { tileSize: 512, size: 2048 }
          ]);
        }
        const initialYaw = 0;
        const initialPitch = 0;
        const view = new Marzipano.RectilinearView({ yaw: initialYaw, pitch: initialPitch, fov: 100 * Math.PI / 180 }, Marzipano.RectilinearView.limit.traditional(2048, 120 * Math.PI / 180));
        const coordinates = document.getElementById('view-coordinates');
        const updateCoordinates = () => {
          const current = view.parameters();
          if (coordinates) {
            coordinates.textContent = 'X: ' + Number(current.yaw || 0).toFixed(2) + ' | Y: ' + Number(current.pitch || 0).toFixed(2);
          }
        };
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
            label.textContent = (hotspot.label || 'Hotspot') + '\\nX: ' + Number(hotspot.yaw || 0).toFixed(2) + '\\nY: ' + Number(hotspot.pitch || 0).toFixed(2);
            marker.appendChild(label);
            marker.title = label.textContent;

            const relativeYaw = Number(hotspot.yaw || 0) - (Number.isFinite(item.yaw) ? Number(item.yaw) : 0);
            const relativePitch = Number(hotspot.pitch || 0) - (Number.isFinite(item.pitch) ? Number(item.pitch) : 0);
            container.createHotspot(marker, { yaw: relativeYaw, pitch: relativePitch });
          });
        }
        scene.switchTo();
      }

        const marzipanoMenu = document.getElementById('menu');
        panoramas.forEach((item, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'menu-item' + (index === 0 ? ' is-active' : '');
          btn.innerHTML = '<img class="thumb" src="' + item.previewUrl + '" /><span class="menu-label">' + item.label + '</span>';
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
</body>
</html>`;
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

async function addExposePageToZip(zip, exportTargets) {
  const threeResponse = await fetch('/node_modules/three/build/three.module.min.js');
  if (!threeResponse.ok) throw new Error('Failed to load Three.js for expose export');
  zip.file('app-files/three.min.js', await threeResponse.arrayBuffer());
  zip.file('app-files/expose.html', buildExposeHtml(exportTargets));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file for preview'));
    reader.readAsDataURL(file);
  });
}

async function splitCubePreviewFaces(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
  const size = Math.floor(image.height / 6);
  const faces = {};
  'bdflru'.split('').forEach((face, index) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(image, 0, index * size, size, size, 0, 0, size, size);
    faces[face] = canvas.toDataURL('image/jpeg', 0.92);
  });
  return faces;
}

function buildPreviewAssetMap() {
  return Promise.all(
    [...panoramaFileGroups.values()].flat().map(async (file) => {
      const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
      const segments = relative.split('/').filter(Boolean);
      const tileIndex = segments.findIndex((segment) => /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment));
      if (tileIndex <= 0) return null;
      const suffix = segments.slice(tileIndex).join('/');
      if (!/\.(jpe?g|png)$/i.test(suffix)) return null;
      return [suffix, await readFileAsDataUrl(file)];
    })
  ).then((entries) => Object.fromEntries(entries.filter(Boolean)));
}

function buildExportTileUrlMap(exportTargets = [], files = []) {
  const map = {};

  files.forEach((file) => {
    const relative = normalizeRelativePath(file.webkitRelativePath || file.relativePath || file.name);
    const segments = relative.split('/').filter(Boolean);
    const tileIndex = segments.findIndex((segment) => /^\d+$/.test(segment) || /^[bdflru]$/i.test(segment));
    if (tileIndex <= 0) return;

    const suffix = segments.slice(tileIndex).join('/');
    const folderName = segments.slice(0, tileIndex).at(-1) || getMarzipanoTileFolder(file) || 'panorama';
    if (!/\.(jpe?g|png)$/i.test(suffix)) return;

    const url = `./tiles/${folderName}/${suffix}`;
    map[suffix] = url;
  });

  exportTargets.forEach((item) => {
    const root = item.root || `./tiles/${item.key}`;
    if (root && item.key) {
      map[`${item.key}/preview.jpg`] = `${root}/preview.jpg`;
    }
  });

  return map;
}

async function addExportSoundsToZip(zip, exportTargets) {
  await Promise.all(exportTargets.flatMap((target) => (target.hotspots || []).map(async (hotspot, index) => {
    const sound = hotspot.sound;
    if (!sound?.url) return;
    if (sound.path) {
      hotspot.sound = { url: sound.path, name: sound.name || sound.path.split('/').pop(), loop: Boolean(sound.loop) };
      return;
    }
    const safeTarget = String(target.key || 'scene').replace(/[^a-z0-9_-]/gi, '_');
    const extension = (sound.name || 'sound.mp3').match(/\.[a-z0-9]+$/i)?.[0] || '.mp3';
    const path = `sounds/${safeTarget}/hotspot-${index + 1}${extension.toLowerCase()}`;
    const response = sound.url.startsWith('data:')
      ? null
      : await fetch(sound.url);
    const bytes = response
      ? await response.arrayBuffer()
      : Uint8Array.from(atob(sound.url.split(',')[1]), (character) => character.charCodeAt(0));
    zip.file(`app-files/${path}`, bytes);
    hotspot.sound = { url: path, name: sound.name || path.split('/').pop(), loop: Boolean(sound.loop) };
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

function buildMarzipanoDataJs(exportTargets = []) {
  const scenes = exportTargets.map((target) => ({
    id: target.key,
    name: target.label || target.key,
    levels: [
      { tileSize: 256, size: 256, fallbackOnly: true },
      { tileSize: 512, size: 512 },
      { tileSize: 512, size: 1024 },
      { tileSize: 512, size: 2048 },
      { tileSize: 512, size: 4096 }
    ],
    faceSize: 2976,
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
  }));
  return `var APP_DATA = ${JSON.stringify({ scenes, name: 'Project Title', settings: { mouseViewMode: 'drag', autorotateEnabled: true, fullscreenButton: false, viewControlButtons: false } }, null, 2)};`;
}

function buildMarzipanoIndexHtml(indexHtml, exportTargets = []) {
  const sceneLinks = exportTargets.map((target) => `      <a href="javascript:void(0)" class="scene" data-id="${target.key}">
        <li class="text">${target.label || target.key}</li>
      </a>`).join('\n');
  return indexHtml.replace(/(<ul class="scenes">)[\s\S]*?(<\/ul>)/, `$1\n${sceneLinks}\n  $2`);
}

function buildStandaloneMarzipanoIndexHtml(exportTargets = []) {
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

function buildStandaloneMarzipanoIndexJs() {
  return `(function() {
  var viewer = new Marzipano.Viewer(document.getElementById('pano'));
  var scenes = APP_DATA.scenes.map(function(data) {
    var source = Marzipano.ImageUrlSource.fromString('tiles/' + data.id + '/{z}/{f}/{y}/{x}.jpg', { cubeMapPreviewUrl: 'tiles/' + data.id + '/preview.jpg' });
    var geometry = new Marzipano.CubeGeometry(data.levels);
    var view = new Marzipano.RectilinearView(data.initialViewParameters, Marzipano.RectilinearView.limit.traditional(data.faceSize, 100 * Math.PI / 180, 120 * Math.PI / 180));
    var scene = viewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true });
    (data.linkHotspots || []).forEach(function(hotspot) {
      var marker = document.createElement('div');
      marker.className = 'link-hotspot';
      var hotspotScale = Math.min(2, Math.max(0.5, Number(hotspot.sizePercent || 100) / 100));
      var hotspotSize = (window.matchMedia && window.matchMedia('(max-width: 500px)').matches ? 70 : 60) * hotspotScale;
      marker.style.width = hotspotSize + 'px';
      marker.style.height = hotspotSize + 'px';
      marker.style.marginLeft = (-hotspotSize / 2) + 'px';
      marker.style.marginTop = (-hotspotSize / 2) + 'px';
      marker.dataset.target = hotspot.target || '';
      marker.dataset.targetYaw = hotspot.targetViewParameters?.yaw ?? hotspot.targetYaw ?? 0;
      marker.dataset.targetPitch = hotspot.targetViewParameters?.pitch ?? hotspot.targetPitch ?? 0;
      marker.dataset.targetFov = hotspot.targetViewParameters?.fov ?? hotspot.targetFov ?? 120;
      marker.dataset.sound = hotspot.sound ? 'true' : 'false';
      marker._hotspotSound = hotspot.sound || null;
      var icon = document.createElement('img');
      icon.src = 'img/link.png';
      icon.className = 'link-hotspot-icon';
      icon.style.transform = 'rotate(' + (hotspot.rotation || 0) + 'rad)';
      marker.appendChild(icon);
      scene.hotspotContainer().createHotspot(marker, { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });
    return { data: data, scene: scene };
  });
  var activeHotspotAudio = null;
  var activeSceneAudio = null;
  var activeSceneVideo = null;
  var activeSceneVideoWrap = null;
  var activeSceneVideoButton = null;
  var activeVideoScene = null;
  function stopHotspotSound() {
    if (activeHotspotAudio) {
      activeHotspotAudio.pause();
      activeHotspotAudio.currentTime = 0;
      activeHotspotAudio = null;
    }
  }
  function showSceneVideoButton(scene) {
    if (activeSceneVideoButton) {
      activeSceneVideoButton.remove();
      activeSceneVideoButton = null;
    }
    if (!scene || !scene.data.sceneVideo || !scene.data.sceneVideo.url) return;
    activeVideoScene = scene;
    activeSceneVideoButton = document.createElement('button');
    activeSceneVideoButton.type = 'button';
    activeSceneVideoButton.className = 'scene-video-reopen';
    activeSceneVideoButton.setAttribute('aria-label', 'Open scene video');
    var preview = document.createElement('video');
    preview.src = scene.data.sceneVideo.url;
    preview.muted = true;
    preview.loop = true;
    preview.playsInline = true;
    preview.autoplay = true;
    preview.controls = false;
    preview.setAttribute('aria-hidden', 'true');
    activeSceneVideoButton.appendChild(preview);
    activeSceneVideoButton.addEventListener('click', function() {
      playSceneVideo(activeVideoScene);
    });
    document.body.appendChild(activeSceneVideoButton);
  }
  function playSceneVideo(scene) {
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
    if (!scene || !scene.data.sceneVideo || !scene.data.sceneVideo.url) return;
    activeVideoScene = scene;
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
      if (activeSceneVideo) {
        activeSceneVideo.pause();
      }
      wrapper.remove();
      if (activeSceneVideoWrap === wrapper) {
        activeSceneVideo = null;
        activeSceneVideoWrap = null;
      }
      showSceneVideoButton(scene);
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
  function playSceneSound(scene) {
    if (activeSceneAudio) { activeSceneAudio.pause(); activeSceneAudio.currentTime = 0; }
    if (!scene || !scene.data.sceneSound || !scene.data.sceneSound.url) return;
    activeSceneAudio = new Audio(scene.data.sceneSound.url);
    activeSceneAudio.loop = Boolean(scene.data.sceneSound.loop);
    activeSceneAudio.play().catch(function() {});
  }
  function switchScene(scene) {
    stopHotspotSound();
    scene.scene.switchTo();
    document.querySelector('.sceneName').textContent = scene.data.name;
    document.querySelectorAll('#sceneList .scene').forEach(function(element) { element.classList.toggle('current', element.getAttribute('data-id') === scene.data.id); });
    playSceneSound(scene);
    playSceneVideo(scene);
  }
  scenes.forEach(function(scene) { var element = document.querySelector('#sceneList .scene[data-id="' + scene.data.id + '"]'); if (element) element.addEventListener('click', function() { switchScene(scene); }); });
  document.querySelectorAll('.link-hotspot[data-target]').forEach(function(marker) {
    marker.addEventListener('click', function() {
      var target = scenes.find(function(item) { return item.data.id === marker.dataset.target; });
      if (target) switchScene(target);
      if (marker._hotspotSound && marker._hotspotSound.url) { stopHotspotSound(); activeHotspotAudio = new Audio(marker._hotspotSound.url); activeHotspotAudio.loop = Boolean(marker._hotspotSound.loop); activeHotspotAudio.play().catch(function() {}); }
    });
  });
  if (scenes.length) switchScene(scenes[0]);
})();`;
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
    : 'function switchScene(scene) {';
  const withVideoButton = withoutVideoFunctions.replace(videoAnchor, `${videoFunction}\n  ${videoAnchor}`);
  return withVideoButton.replace('playSceneVideo(scene);', 'activeVideoScene = scene; playSceneVideo(scene);');
}

function patchExportHotspotStyleCss(styleCss) {
  if (styleCss.includes('--hotspot-size')) return styleCss;
  return styleCss
    .replace(
      `  width: 60px;
  height: 60px;
  margin-left: -30px;
  margin-top: -30px;`,
      `  --hotspot-size: 60px;
  width: var(--hotspot-size);
  height: var(--hotspot-size);
  margin-left: calc(var(--hotspot-size) / -2);
  margin-top: calc(var(--hotspot-size) / -2);`
    )
    .replace(
      `  width: 70px;
  height: 70px;`,
      `  --hotspot-size: 70px;
  width: var(--hotspot-size);
  height: var(--hotspot-size);`
    );
}

function patchExportAvatarStyleCss(styleCss) {
  const replacementCss = `.scene-avatar-video-wrap { position: fixed; z-index: 20; right: 18px; bottom: 18px; width: 180px; height: 225px; overflow: visible; }\n.scene-avatar-video-caption { position: absolute; right: 8px; bottom: 8px; z-index: 5; max-width: calc(100% - 16px); padding: 4px 8px; border-radius: 8px; background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; line-height: 1.2; letter-spacing: 0.02em; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.scene-avatar-video { position: absolute !important; inset: 0 !important; z-index: 0; display: block; width: 100% !important; height: 100% !important; object-fit: cover; border: 2px solid #fff; border-radius: 16px; background: #111; box-shadow: 0 8px 24px rgba(0,0,0,.45); }\n.scene-avatar-video-close { position: absolute !important; top: 0 !important; right: 0 !important; z-index: 30 !important; width: 48px; height: 48px; margin: 0 !important; padding: 0; transform: none !important; border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 32px; line-height: 48px; cursor: pointer; text-shadow: 0 1px 4px rgba(0,0,0,.8); }\n.scene-avatar-video-play { position: absolute; left: 50%; top: 50%; z-index: 30; width: 72px; height: 72px; margin: 0; padding: 0; transform: translate(-50%, -50%); border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 34px; line-height: 72px; cursor: pointer; text-shadow: 0 1px 5px rgba(0,0,0,.85); }\n.scene-video-reopen { position: fixed; z-index: 21; right: 18px; bottom: 18px; width: 48px; height: 48px; padding: 0; border: 2px solid #fff; border-radius: 50%; background: rgba(34, 132, 83, .92); color: #fff; font-size: 22px; line-height: 44px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.35); }\n.scene-video-reopen:hover { background: #2eaa6c; }\n.scene-avatar-video-wrap.is-playing .scene-avatar-video-play { opacity: 0; pointer-events: none; }\n.scene-avatar-video-wrap.is-playing:hover .scene-avatar-video-play { opacity: 1; pointer-events: auto; }\n@media (max-width: 600px) { .scene-avatar-video-wrap { right: 10px; bottom: 10px; width: 125px; height: 156px; } .scene-avatar-video-close { width: 42px; height: 42px; line-height: 42px; font-size: 28px; } .scene-avatar-video-play { width: 60px; height: 60px; line-height: 60px; font-size: 30px; } .scene-video-reopen { right: 10px; bottom: 10px; width: 44px; height: 44px; line-height: 40px; } }`;
  const videoThumbnailCss = `.scene-video-reopen { width: 58px !important; height: 58px !important; padding: 0 !important; overflow: hidden !important; border: 3px solid #fff !important; border-radius: 50% !important; background: #222 !important; color: transparent !important; font-size: 0 !important; line-height: 0 !important; } .scene-video-reopen video { display: block; width: 100%; height: 100%; object-fit: cover; pointer-events: none; } .scene-video-reopen::after { content: '\\25B6'; position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 19px; text-shadow: 0 1px 4px rgba(0,0,0,.8); background: rgba(0,0,0,.16); } .scene-video-reopen:hover { transform: scale(1.08); } @media (max-width: 600px) { .scene-video-reopen { width: 52px !important; height: 52px !important; } }`;

  if (!styleCss.includes('.scene-avatar-video-wrap')) {
    return `${styleCss}\n${replacementCss}\n${videoThumbnailCss}`;
  }

  return styleCss
    .replace(/\.scene-avatar-video\s*\{[^}]*\}/g, '.scene-avatar-video { position: absolute !important; inset: 0 !important; z-index: 0; display: block; width: 100% !important; height: 100% !important; object-fit: cover; border: 2px solid #fff; border-radius: 16px; background: #111; box-shadow: 0 8px 24px rgba(0,0,0,.45); }')
    .replace(/\.scene-avatar-video-wrap\s*\{[^}]*\}/g, '.scene-avatar-video-wrap { position: fixed; z-index: 20; right: 18px; bottom: 18px; width: 180px; aspect-ratio: 4 / 5; }')
    .replace(/@media \(max-width: 600px\) \{[^}]*\.scene-avatar-video\s*\{[^}]*\}\s*\}/g, '@media (max-width: 600px) { .scene-avatar-video-wrap { right: 10px; bottom: 10px; width: 125px; height: 156px; } }')
    .replace(/\.scene-avatar-video-close\s*\{[^}]*\}/g, '.scene-avatar-video-close { position: absolute !important; top: 0 !important; right: 0 !important; z-index: 30 !important; width: 48px; height: 48px; margin: 0 !important; padding: 0; transform: none !important; border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 32px; line-height: 48px; cursor: pointer; text-shadow: 0 1px 4px rgba(0,0,0,.8); }')
    .replace(/\.scene-avatar-video-play\s*\{[^}]*\}/g, '') + '\n.scene-avatar-video-play { position: absolute; left: 50%; top: 50%; z-index: 30; width: 72px; height: 72px; margin: 0; padding: 0; transform: translate(-50%, -50%); border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 34px; line-height: 72px; cursor: pointer; text-shadow: 0 1px 5px rgba(0,0,0,.85); }\n' + videoThumbnailCss + '\n.scene-video-reopen { top: 68px !important; bottom: auto !important; }\n@media (max-width: 600px) { .scene-video-reopen { top: 68px !important; bottom: auto !important; } }';
}

function buildStandaloneMarzipanoStyleCss() {
  return `html, body, #pano { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
#pano { position: absolute; inset: 0; }
#sceneList { position: absolute; top: 20px; left: 20px; z-index: 2; background: rgba(0,0,0,.65); padding: 10px; }
.scenes { margin: 0; padding: 0; list-style: none; }
.scene { display: block; padding: 6px 10px; color: #fff; font: 14px sans-serif; text-decoration: none; cursor: pointer; }
.scene.current { background: rgba(255,255,255,.2); }
#titleBar { position: absolute; left: 20px; bottom: 20px; z-index: 2; color: #fff; font: 16px sans-serif; }
.link-hotspot { width: 60px; height: 60px; margin: -30px; opacity: .9; cursor: pointer; }
.link-hotspot-icon { width: 100%; height: 100%; }
.scene-avatar-video-wrap { position: fixed; z-index: 20; right: 18px; bottom: 18px; width: 180px; height: 225px; overflow: visible; }
.scene-avatar-video { position: absolute !important; inset: 0 !important; z-index: 0; display: block; width: 100% !important; height: 100% !important; object-fit: cover; border: 2px solid #fff; border-radius: 16px; background: #111; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
.scene-avatar-video-close { position: absolute !important; top: 0 !important; right: 0 !important; z-index: 30 !important; width: 48px; height: 48px; margin: 0 !important; padding: 0; transform: none !important; border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 32px; line-height: 48px; cursor: pointer; text-shadow: 0 1px 4px rgba(0,0,0,.8); }
.scene-avatar-video-play { position: absolute; left: 50%; top: 50%; z-index: 30; width: 72px; height: 72px; margin: 0; padding: 0; transform: translate(-50%, -50%); border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 34px; line-height: 72px; cursor: pointer; text-shadow: 0 1px 5px rgba(0,0,0,.85); }
.scene-video-reopen { position: fixed; z-index: 21; top: 68px; right: 18px; bottom: auto; width: 52px; height: 52px; padding: 0; overflow: hidden; border: 2px solid #fff; border-radius: 50%; background: rgba(34, 132, 83, .92); box-shadow: 0 4px 12px rgba(0,0,0,.35); cursor: pointer; }
.scene-video-reopen video { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.scene-video-reopen:hover { background: #2eaa6c; }
.scene-avatar-video-caption { position: absolute; right: 8px; bottom: 8px; z-index: 5; max-width: calc(100% - 16px); padding: 4px 8px; border-radius: 8px; background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; line-height: 1.2; letter-spacing: 0.02em; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 600px) { .scene-avatar-video-wrap { right: 10px; bottom: 10px; width: 125px; height: 156px; } .scene-video-reopen { top: 68px; right: 10px; width: 46px; height: 46px; } }`;
}



async function buildTemplatePreviewHtml(exportTargets, tileUrlMap, marzipanoScript = '') {
  const [indexResponse, styleResponse] = await Promise.all([
    fetch('/marzipano-template/app-files/index.html'),
    fetch('/marzipano-template/app-files/style.css')
  ]);
  if (!indexResponse.ok || !styleResponse.ok) return '';
  let html = await indexResponse.text();
  const css = await styleResponse.text();
  html = html.replace(/<link rel="stylesheet" href="vendor\/reset\.min\.css">/i, '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>');
  html = html.replace(/<link rel="stylesheet" href="style\.css">/i, `<style>${css}</style>`);
  html = html.replace(/src="img\//g, 'src="/marzipano-template/app-files/img/');
  html = html.replace(/<script[^>]+src="vendor\/screenfull\.min\.js"[^>]*><\/script>/i, '');
  html = html.replace(/<script[^>]+src="vendor\/bowser\.min\.js"[^>]*><\/script>/i, '');
  html = html.replace(/<script[^>]+src="vendor\/marzipano\.js"[^>]*><\/script>/i, `<script>${marzipanoScript}</script>`);
  html = html.replace(/<script[^>]+src="data\.js"[^>]*><\/script>/i, '');
  html = html.replace(/<script[^>]+src="index\.js"[^>]*><\/script>/i, ``);
  const sceneLinks = exportTargets.map((target) => `      <a href="javascript:void(0)" class="scene" data-id="${target.key}"><li class="text">${target.label || target.key}</li></a>`).join('\n');
  html = html.replace(/(<ul class="scenes">)[\s\S]*?(<\/ul>)/, `$1\n${sceneLinks}\n  $2`);
  return html;
}

async function addBundledMarzipanoTemplate(zip) {
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

async function openExportPreview() {
  if (!currentFile && !panoramaFileGroups.size) return;

  const sceneName = document.querySelector('#scene-name')?.textContent || 'scene';
  const exportTargets = buildExportTargets();
  const currentKey = currentPanoramaKey();
  const activeHotspots = panoramaHotspots.get(currentKey) || [];
  const previewTargets = await Promise.all(exportTargets.map(async (item) => {
    const key = item.key;
    const files = panoramaFileGroups.get(key) || [];
    const previewFile = files.find((file) => isPreviewFile(file)) || files[0] || currentMarzipanoFiles.find((file) => isPreviewFile(file)) || currentMarzipanoFiles[0] || (key === currentKey && currentFileType !== 'zip' ? currentFile : null);
    const keyHotspots = panoramaHotspots.get(key) || [];
    const targetHotspots = keyHotspots.length ? keyHotspots : activeHotspots.length ? activeHotspots : [];

    return {
      ...item,
      previewUrl: previewFile ? await readFileAsDataUrl(previewFile) : (currentZipPreviewUrls.get(key) || item.previewUrl),
      previewFaceUrls: currentZipPreviewUrls.has(key) ? await splitCubePreviewFaces(currentZipPreviewUrls.get(key)) : {},
      hotspots: targetHotspots.map((hotspot) => ({
        label: hotspot.label || 'Hotspot',
        yaw: hotspot.yaw,
        pitch: hotspot.pitch,
        sizePercent: Math.min(200, Math.max(50, Number(hotspot.sizePercent) || 100)),
        rotation: Number(hotspot.rotation || 0)
      }))
    };
  }));
  const tileUrlMap = await buildPreviewAssetMap();
  Object.assign(tileUrlMap, currentZipPreviewTileMap);
  tileUrlMap.__hotspotIcon = currentZipLinkIconUrl || '';
  const marzipanoScript = await fetch('/node_modules/marzipano/dist/marzipano.js').then((response) => response.text()).catch(() => '');
  const html = await buildTemplatePreviewHtml(previewTargets, tileUrlMap, marzipanoScript) || buildExportHtml(previewTargets, sceneName, tileUrlMap, marzipanoScript, 'inline');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const previewUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = previewUrl;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
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
    const exportTargets = buildExportTargets();

    if (currentZipArchive) {
      await Promise.all(Object.entries(currentZipArchive.files).filter(([, entry]) => !entry.dir).map(async ([path, entry]) => {
        zip.file(path, await entry.async('arraybuffer'));
      }));
      [...panoramaFileGroups.entries()].forEach(([key, files]) => {
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
      await addExportSoundsToZip(zip, exportTargets);
      zip.file('app-files/data.js', buildMarzipanoDataJs(exportTargets));
      const originalIndexHtml = await currentZipArchive.file('app-files/index.html').async('string');
      zip.file('app-files/index.html', buildMarzipanoIndexHtml(originalIndexHtml, exportTargets));
      const originalIndexJsFile = currentZipArchive.file('app-files/index.js');
      if (originalIndexJsFile) {
        const originalIndexJs = await originalIndexJsFile.async('string');
        const hasPageSoundCall = originalIndexJs.includes('playSceneSound(scene);');
        let updatedIndexJs = patchExportSceneVideoIndexJs(patchExportHotspotIndexJs(originalIndexJs)).replace(/activeSceneAudio\.loop\s*=\s*true\s*;/g, 'activeSceneAudio.loop = Boolean(scene.data.sceneSound.loop);').replace(
          'var data = window.APP_DATA;',
          "var data = window.APP_DATA; var activeHotspotAudio = null; var activeSceneAudio = null; function stopHotspotSound() { if (activeHotspotAudio) { activeHotspotAudio.pause(); activeHotspotAudio.currentTime = 0; } activeHotspotAudio = null; } function playHotspotSound(hotspot) { if (!hotspot.sound || !hotspot.sound.url) return; stopHotspotSound(); activeHotspotAudio = new Audio(hotspot.sound.url); activeHotspotAudio.loop = Boolean(hotspot.sound.loop); activeHotspotAudio.play().catch(function() {}); } function stopSceneSound() { if (activeSceneAudio) { activeSceneAudio.pause(); activeSceneAudio.currentTime = 0; activeSceneAudio = null; } } function playSceneSound(scene) { stopSceneSound(); if (!scene || !scene.data.sceneSound || !scene.data.sceneSound.url) return; activeSceneAudio = new Audio(scene.data.sceneSound.url); activeSceneAudio.loop = Boolean(scene.data.sceneSound.loop); activeSceneAudio.play().catch(function() {}); }"
        ).replace(
          'tooltip.innerHTML = findSceneDataById(hotspot.target).name;',
          "tooltip.innerHTML = hotspot.text || findSceneDataById(hotspot.target).name;"
        ).replace(
          'function switchScene(scene) {',
          'function switchScene(scene) { stopHotspotSound();'
        ).replace(
          'updateSceneList(scene);',
          hasPageSoundCall ? 'updateSceneList(scene);' : 'updateSceneList(scene); playSceneSound(scene);'
        ).replace(
          'switchScene(findSceneById(hotspot.target));',
          "var targetScene = findSceneById(hotspot.target); if (targetScene) { var targetView = hotspot.targetViewParameters || {}; targetScene.data.initialViewParameters = { yaw: Number(targetView.yaw || targetScene.data.initialViewParameters.yaw || 0), pitch: Number(targetView.pitch || targetScene.data.initialViewParameters.pitch || 0), fov: Number(targetView.fov || 120) * Math.PI / 180 }; switchScene(targetScene); } playHotspotSound(hotspot);"
        );
        updatedIndexJs = updatedIndexJs.replace(/(?:\s*playSceneSound\(scene\);){2,}/g, '\n    playSceneSound(scene);');
        updatedIndexJs = updatedIndexJs.replace(
          /updateSceneList\(scene\);(?:\s*playSceneSound\(scene\);)?(?:\s*playSceneVideo\(scene\);)?/,
          'updateSceneList(scene); playSceneSound(scene); playSceneVideo(scene);'
        );
        zip.file('app-files/index.js', updatedIndexJs);
      }
      const originalStyleCssFile = currentZipArchive.file('app-files/style.css');
      if (originalStyleCssFile) {
        const originalStyleCss = await originalStyleCssFile.async('string');
        zip.file('app-files/style.css', patchExportAvatarStyleCss(patchExportHotspotStyleCss(originalStyleCss)));
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
    zip.file('app-files/index.html', buildMarzipanoIndexHtml(templateIndexHtml, exportTargets));
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
const folderInput = document.querySelector('#folder-input');
const headerFileTrigger = document.querySelector('#header-file-trigger');
const headerFolderTrigger = document.querySelector('#header-folder-trigger');

headerFileTrigger?.addEventListener('click', () => fileInput?.click());
headerFolderTrigger?.addEventListener('click', () => folderInput?.click());

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
attachHeaderDropHandlers(headerFolderTrigger, true);

fileInput?.addEventListener('change', (event) => {
  addFiles(event.target.files || []);
  event.target.value = '';
});
folderInput?.addEventListener('change', (event) => {
  addFiles(event.target.files || [], true);
  event.target.value = '';
});
document.querySelector('#export-btn').addEventListener('click', exportScene);
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
