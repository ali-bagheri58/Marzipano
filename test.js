import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './test.css';

const viewer = document.querySelector('#viewer');
const openImageButton = document.querySelector('#open-image');
const imageInput = document.querySelector('#image-input');
const emptyState = document.querySelector('#empty-state');
const imageName = document.querySelector('#image-name');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#171e20');
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 0.2, 3.4);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.autoRotate = false;
controls.autoRotateSpeed = 2.8;
controls.minDistance = 2.1;
controls.maxDistance = 5.5;
controls.rotateSpeed = -0.55;

scene.add(new THREE.HemisphereLight('#f2f5e8', '#172326', 2.4));
const keyLight = new THREE.DirectionalLight('#fff6d5', 2.8);
keyLight.position.set(2, 3, 4);
scene.add(keyLight);

const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.2, 96, 64),
  new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .82, metalness: 0 })
);
sphere.visible = false;
scene.add(sphere);

function resize() {
  const { width, height } = viewer.getBoundingClientRect();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function loadImage(source, label) {
  new THREE.TextureLoader().load(source, (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    sphere.material.map = texture;
    sphere.material.needsUpdate = true;
    sphere.visible = true;
    controls.autoRotate = true;
    emptyState.hidden = true;
    imageName.textContent = label;
  }, undefined, () => {
    imageName.textContent = 'Failed to load image';
  });
}

openImageButton.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  const objectUrl = URL.createObjectURL(file);
  loadImage(objectUrl, file.name);
});

window.addEventListener('resize', resize);
resize();

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
