import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createSceneController(sceneHost) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#171c1f');

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(3.5, 2.2, 4.8);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sceneHost.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = -0.38;
  controls.zoomSpeed = 0.45;
  controls.minDistance = 1.5;
  controls.maxDistance = 12;
  controls.target.set(0, 0.8, 0);

  scene.add(new THREE.HemisphereLight('#eef4e2', '#172125', 2.2));
  const keyLight = new THREE.DirectionalLight('#fff6d5', 4.2);
  keyLight.position.set(3, 6, 4);
  keyLight.castShadow = true;
  scene.add(keyLight);

  const rimLight = new THREE.PointLight('#b9d86a', 18, 8);
  rimLight.position.set(-3, 2.5, -2);
  scene.add(rimLight);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(5, 64),
    new THREE.MeshStandardMaterial({ color: '#22292b', roughness: 0.94, metalness: 0.04 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.06;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(8, 16, '#48534e', '#2b3334');
  grid.position.y = -0.045;
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  scene.add(grid);

  const defaultModel = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: '#d8fa5a', roughness: 0.3, metalness: 0.55 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: '#283238', roughness: 0.2, metalness: 0.8 });

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 2), material);
  core.position.y = 1.25;
  core.castShadow = true;
  defaultModel.add(core);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.045, 12, 64), darkMaterial);
  ring.rotation.x = 0.82;
  ring.position.y = 1.2;
  ring.castShadow = true;
  defaultModel.add(ring);

  const ring2 = ring.clone();
  ring2.rotation.x = 1.9;
  ring2.rotation.z = 0.4;
  defaultModel.add(ring2);

  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.82, 0.22, 48), darkMaterial);
  pedestal.position.y = 0.11;
  pedestal.castShadow = true;
  defaultModel.add(pedestal);

  scene.add(defaultModel);

  return {
    scene,
    camera,
    renderer,
    controls,
    defaultModel,
    floor,
    grid,
    core,
    ring,
    ring2,
    pedestal
  };
}

export function resizeScene(sceneHost, camera, renderer) {
  const { width, height } = sceneHost.getBoundingClientRect();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

export function frameModel(model, camera, controls) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z) || 1;

  model.position.sub(center);
  model.position.y += largest * 0.5;

  const distance = largest * 3.8;
  camera.position.set(distance, distance * 0.62, distance);
  controls.target.set(0, largest * 0.48, 0);
  controls.minDistance = largest * 0.55;
  controls.maxDistance = largest * 8;
  controls.update();
}

export function disposeModel(model) {
  if (!model) return;
  model.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => material.dispose());
    }
  });
}
