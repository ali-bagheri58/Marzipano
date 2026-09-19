/**
 * Local equirectangular → cube-face tile worker.
 *
 * Protocol (matches the interface expected by createOfficialEquirectSource):
 *
 * Incoming message:
 *   { fileData: { file, width, height }, levels, cubeMapPreviewSize, cubeMapPreviewFaceOrder }
 *
 * Outgoing messages:
 *   { msg: 'tile', level, face, v, h, tileArray }   — one per tile (ImageData pixel buffer as Uint8ClampedArray)
 *   { msg: 'done', cubeMapPreviewArray }             — preview is a vertical strip (faceOrder × size) JPEG as Uint8Array
 *
 * Face letters follow Marzipano convention: b d f l r u
 *   f = front  (+Z)   yaw=0
 *   r = right  (+X)   yaw=π/2
 *   b = back   (-Z)   yaw=π
 *   l = left   (-X)   yaw=-π/2 (3π/2)
 *   u = up     (+Y)
 *   d = down   (-Y)
 */

/* ─── Face definitions ──────────────────────────────────────────── */
// For each face we define a function that maps a (u,v) ∈ [-1,1]²
// to a 3-D direction vector, then we convert that to equirectangular (lon, lat).

const FACE_TRANSFORM = {
  f: (u, v) => [u, -v, 1],   // front  (+Z)
  b: (u, v) => [-u, -v, -1], // back   (-Z)
  r: (u, v) => [1, -v, -u],  // right  (+X)
  l: (u, v) => [-1, -v, u],  // left   (-X)
  u: (u, v) => [u, 1, v],    // up     (+Y)  — v points into the sphere
  d: (u, v) => [u, -1, -v],  // down   (-Y)
};

function dirToEquirect(dir) {
  const [x, y, z] = dir;
  const lon = Math.atan2(x, z);           // [-π, π]
  const lat = Math.atan2(y, Math.sqrt(x * x + z * z)); // [-π/2, π/2]
  return { lon, lat };
}

/**
 * Sample the equirectangular ImageData at a continuous (lon, lat).
 * Uses bilinear interpolation.
 */
function sampleEquirect(pixels, srcW, srcH, lon, lat) {
  // Normalise longitude to [0, 2π)
  const normLon = ((lon % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Map to pixel coordinates
  const px = (normLon / (2 * Math.PI)) * srcW;
  const py = ((Math.PI / 2 - lat) / Math.PI) * srcH;

  // Bilinear neighbours
  const x0 = Math.floor(px) % srcW;
  const x1 = (x0 + 1) % srcW;
  const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(py)));
  const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));

  const fx = px - Math.floor(px);
  const fy = py - Math.floor(py);

  const base00 = (y0 * srcW + x0) * 4;
  const base10 = (y0 * srcW + x1) * 4;
  const base01 = (y1 * srcW + x0) * 4;
  const base11 = (y1 * srcW + x1) * 4;

  const r = bilinear(pixels[base00], pixels[base10], pixels[base01], pixels[base11], fx, fy);
  const g = bilinear(pixels[base00 + 1], pixels[base10 + 1], pixels[base01 + 1], pixels[base11 + 1], fx, fy);
  const b = bilinear(pixels[base00 + 2], pixels[base10 + 2], pixels[base01 + 2], pixels[base11 + 2], fx, fy);

  return [r, g, b];
}

function bilinear(v00, v10, v01, v11, fx, fy) {
  return (v00 * (1 - fx) * (1 - fy) +
          v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy +
          v11 * fx * fy);
}

/* ─── Render one cube face tile ─────────────────────────────────── */
/**
 * Renders a single cube-face tile into a Uint8ClampedArray (RGBA).
 *
 * @param {Uint8ClampedArray} equirectPixels - Raw RGBA pixels of the source equirect image
 * @param {number} srcW  - Width of the source image (must equal srcH * 2)
 * @param {number} srcH  - Height of the source image
 * @param {string} face  - One of b d f l r u
 * @param {number} tileSize  - Output tile dimension in pixels (square)
 * @param {number} levelSize - Full face resolution at this zoom level (e.g. 512, 1024 …)
 * @param {number} tileX - Column index of this tile within the face grid (0-based)
 * @param {number} tileY - Row    index of this tile within the face grid (0-based)
 */
function renderTile(equirectPixels, srcW, srcH, face, tileSize, levelSize, tileX, tileY) {
  const transform = FACE_TRANSFORM[face];
  const out = new Uint8ClampedArray(tileSize * tileSize * 4);

  for (let py = 0; py < tileSize; py++) {
    for (let px = 0; px < tileSize; px++) {
      // Pixel position within the FULL face at this level (in pixels, 0…levelSize)
      const facePixelX = tileX * tileSize + px + 0.5;
      const facePixelY = tileY * tileSize + py + 0.5;

      // Normalise to [-1, 1]
      const u = (facePixelX / levelSize) * 2 - 1;
      const v = (facePixelY / levelSize) * 2 - 1;

      const dir = transform(u, v);
      const { lon, lat } = dirToEquirect(dir);
      const [r, g, b] = sampleEquirect(equirectPixels, srcW, srcH, lon, lat);

      const idx = (py * tileSize + px) * 4;
      out[idx]     = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = 255;
    }
  }
  return out;
}

/* ─── Encode pixels to JPEG via OffscreenCanvas ─────────────────── */
async function pixelsToJpeg(pixels, width, height, quality = 0.88) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = new ImageData(pixels, width, height);
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/* ─── Render a preview vertical strip (faceOrder × size) ────────── */
async function renderPreview(equirectPixels, srcW, srcH, previewSize, faceOrder) {
  const faces = faceOrder.split('');
  const totalH = previewSize * faces.length;
  const canvas = new OffscreenCanvas(previewSize, totalH);
  const ctx = canvas.getContext('2d');

  for (let fi = 0; fi < faces.length; fi++) {
    const pixels = renderTile(equirectPixels, srcW, srcH, faces[fi], previewSize, previewSize, 0, 0);
    const imageData = new ImageData(pixels, previewSize, previewSize);
    ctx.putImageData(imageData, 0, fi * previewSize);
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/* ─── Main message handler ──────────────────────────────────────── */
self.addEventListener('message', async (event) => {
  try {
    const { fileData, levels, cubeMapPreviewSize = 256, cubeMapPreviewFaceOrder = 'bdflru' } = event.data || {};
    // normW / normH are the normalised (strict 2:1) dimensions sent by the main thread.
    const { file, width: normW, height: normH } = fileData || {};

    // Decode the equirectangular image and draw it at the normalised 2:1 size.
    // This handles cameras that produce slightly non-2:1 images.
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(normW, normH);
    const ctx = canvas.getContext('2d');
    // drawImage with explicit destination size resamples if needed
    ctx.drawImage(bitmap, 0, 0, normW, normH);
    bitmap.close();
    const equirectPixels = ctx.getImageData(0, 0, normW, normH).data;

    const faces = ['b', 'd', 'f', 'l', 'r', 'u'];

    // Pre-compute total tile count so we can send per-tile progress.
    const totalTiles = levels.reduce((sum, level) => {
      const tilesPerSide = Math.ceil(level.size / level.tileSize);
      return sum + faces.length * tilesPerSide * tilesPerSide;
    }, 0);
    let completedTiles = 0;

    // Generate all tiles for each level
    for (const level of levels) {
      const { tileSize, size: levelSize } = level;
      const tilesPerSide = Math.ceil(levelSize / tileSize);

      for (const face of faces) {
        for (let ty = 0; ty < tilesPerSide; ty++) {
          for (let tx = 0; tx < tilesPerSide; tx++) {
            // Last tile in a row/col may be smaller
            const actualW = Math.min(tileSize, levelSize - tx * tileSize);
            const actualH = Math.min(tileSize, levelSize - ty * tileSize);

            const fullTile = renderTile(equirectPixels, normW, normH, face, tileSize, levelSize, tx, ty);

            // Crop to actual size if the tile is at the edge
            let tilePixels = fullTile;
            if (actualW !== tileSize || actualH !== tileSize) {
              tilePixels = new Uint8ClampedArray(actualW * actualH * 4);
              for (let row = 0; row < actualH; row++) {
                tilePixels.set(
                  fullTile.subarray(row * tileSize * 4, row * tileSize * 4 + actualW * 4),
                  row * actualW * 4
                );
              }
            }

            const jpegData = await pixelsToJpeg(tilePixels, actualW, actualH);

            completedTiles += 1;
            self.postMessage(
              { msg: 'tile', level, face, v: ty, h: tx, tileArray: jpegData, completedTiles, totalTiles },
              [jpegData.buffer]
            );
          }
        }
      }
    }

    // Generate preview
    const previewArray = await renderPreview(
      equirectPixels, normW, normH,
      cubeMapPreviewSize, cubeMapPreviewFaceOrder
    );

    self.postMessage({ msg: 'done', cubeMapPreviewArray: previewArray }, [previewArray.buffer]);

  } catch (err) {
    self.postMessage({ msg: 'error', error: String(err?.message || err) });
  }
});
