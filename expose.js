import Marzipano from 'marzipano';
import './expose.css';

const host = document.querySelector('#expose');
const openImageButton = document.querySelector('#open-image');
const playButton = document.querySelector('#play-slideshow');
const imageInput = document.querySelector('#image-input');

const galleryState = {
  files: [],
  index: 0,
  timer: null,
  viewer: null,
  scene: null,
  isPlaying: false
};

function destroySlideViewer() {
  if (galleryState.scene) {
    try {
      galleryState.scene.stopMovement();
    } catch {
      // no-op
    }
  }

  if (!galleryState.viewer) return;

  try {
    galleryState.viewer.destroy();
  } catch {
    // no-op
  }

  galleryState.viewer = null;
  galleryState.scene = null;
}

function startPanoramaMotion() {
  if (!galleryState.scene || !galleryState.viewer) return;

  const autorotate = Marzipano.autorotate({
    yawSpeed: 0.12,
    pitchSpeed: 0,
    fovSpeed: 0,
    targetPitch: 0,
    targetFov: Math.PI / 2
  });

  try {
    galleryState.scene.startMovement(autorotate);
    galleryState.viewer.setIdleMovement(3000, autorotate);
  } catch {
    // no-op
  }
}

function buildSlideViewer() {
  let viewer = document.querySelector('#slide-viewer');
  if (viewer) return viewer;

  viewer = document.createElement('div');
  viewer.id = 'slide-viewer';
  viewer.className = 'slide-viewer';
  viewer.innerHTML = `
    <div class="slide-shell">
      <button type="button" class="slide-close" aria-label="Close slideshow"></button>
      <div class="slide-stage">
        <div class="slide-stage-fallback"></div>
      </div>
      <div class="slide-meta">
        <span id="slide-counter">1 / 1</span>
        <span id="slide-name"></span>
      </div>
    </div>
  `;

  viewer.querySelector('.slide-close').addEventListener('click', stopSlideshow);
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer || event.target.closest('.slide-shell')) {
      stopSlideshow();
    }
  });
  document.body.appendChild(viewer);
  return viewer;
}

function stopSlideshow() {
  if (galleryState.timer) {
    clearInterval(galleryState.timer);
    galleryState.timer = null;
  }

  galleryState.isPlaying = false;
  destroySlideViewer();

  const viewer = document.querySelector('#slide-viewer');
  if (viewer) {
    viewer.classList.remove('is-visible');
  }

  if (playButton) {
    playButton.textContent = 'Play';
    playButton.classList.remove('is-active');
  }
}

function preloadImageUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => resolve(objectUrl);
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Image could not be loaded'));
    };

    img.src = objectUrl;
  });
}

async function showSlide(index) {
  if (!galleryState.files.length) return;

  const viewer = buildSlideViewer();
  const stage = viewer.querySelector('.slide-stage');
  const fallback = viewer.querySelector('.slide-stage-fallback');
  const counter = viewer.querySelector('#slide-counter');
  const name = viewer.querySelector('#slide-name');
  const file = galleryState.files[index];

  galleryState.index = index;
  destroySlideViewer();

  let objectUrl = '';
  try {
    objectUrl = await preloadImageUrl(file);
  } catch {
    return;
  }

  if (fallback) {
    fallback.style.backgroundImage = `url(${objectUrl})`;
    fallback.style.display = 'block';
  }

  const panoramaViewer = new Marzipano.Viewer(stage, { stage: { progressive: true } });
  const source = new Marzipano.ImageUrlSource(() => ({ url: objectUrl }));
  const geometry = new Marzipano.EquirectGeometry([
    { tileSize: 1024, size: 1024 },
    { tileSize: 2048, size: 2048 }
  ]);
  const view = new Marzipano.RectilinearView(
    { yaw: 0, pitch: 0, fov: 100 * Math.PI / 180 },
    Marzipano.RectilinearView.limit.traditional(2048, 120 * Math.PI / 180)
  );

  const scene = panoramaViewer.createScene({ source, geometry, view, pinFirstLevel: true });

  galleryState.viewer = panoramaViewer;
  galleryState.scene = scene;

  viewer.classList.add('is-visible');

  requestAnimationFrame(() => {
    panoramaViewer.updateSize();
    scene.switchTo();
    panoramaViewer.renderLoop().renderOnNextFrame();
    if (fallback) {
      fallback.style.display = 'none';
    }
    setTimeout(() => {
      startPanoramaMotion();
    }, 120);
  });

  counter.textContent = `${index + 1} / ${galleryState.files.length}`;
  name.textContent = file.name;
}

function startSlideshow() {
  if (!galleryState.files.length) return;

  if (galleryState.isPlaying) {
    stopSlideshow();
    return;
  }

  galleryState.isPlaying = true;
  showSlide(0);

  if (playButton) {
    playButton.textContent = 'Pause';
    playButton.classList.add('is-active');
  }

  galleryState.timer = setInterval(() => {
    const nextIndex = galleryState.index + 1;

    if (nextIndex >= galleryState.files.length) {
      showSlide(0);
      return;
    }

    showSlide(nextIndex);
  }, 15000);
}

function renderGallery() {
  host.innerHTML = '';

  if (!galleryState.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Choose one or more images to load them into the expose gallery.';
    host.appendChild(empty);
    return;
  }

  galleryState.files.forEach((file) => {
    const card = document.createElement('article');
    card.className = 'scene-card';

    const preview = document.createElement('div');
    preview.className = 'marzipano-host';

    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.loading = 'lazy';

    const label = document.createElement('div');
    label.className = 'scene-label';
    label.textContent = file.name;

    preview.appendChild(img);
    card.appendChild(preview);
    card.appendChild(label);
    host.appendChild(card);
  });
}

function loadSelectedFiles(files = []) {
  const validFiles = [...files].filter((file) => file && file.type.startsWith('image/'));
  if (!validFiles.length) return;

  stopSlideshow();
  galleryState.files = [...galleryState.files, ...validFiles];
  galleryState.index = 0;
  renderGallery();
  if (playButton) {
    playButton.textContent = 'Play';
    playButton.classList.remove('is-active');
  }
}

openImageButton.addEventListener('click', () => imageInput.click());
playButton.addEventListener('click', () => {
  if (!galleryState.files.length) {
    imageInput.click();
    return;
  }

  if (galleryState.isPlaying) {
    stopSlideshow();
    return;
  }

  startSlideshow();
});

imageInput.addEventListener('change', (event) => {
  const files = event.target.files;
  loadSelectedFiles(files);
  requestAnimationFrame(() => {
    imageInput.value = '';
  });
});

renderGallery();
