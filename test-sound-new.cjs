const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('http://localhost:5174/');
  await page.waitForLoadState('networkidle');

  // Load a fresh JPG (not an already-exported ZIP)
  await page.locator('#file-input').setInputFiles('C:/Users/Aliba/Downloads/IMG_20260227_151614_00_011_jpg.zip');
  await page.waitForFunction(() => { const s = document.querySelector('#status'); return !s || s.innerHTML === ''; }, { timeout: 60000 });
  console.log('ZIP loaded');

  // Add a hotspot sound via properties dialog
  // Click on first scene
  const firstItem = page.locator('#files .file-item').first();
  await firstItem.locator('.scene-properties-btn').click();
  await page.waitForSelector('.hotspot-dialog', { timeout: 5000 });
  
  // Set scene sound  
  const soundInput = page.locator('.scene-sound-input');
  // Create a real audio file to test with
  const testMp3Path = path.join(os.tmpdir(), 'test-sound.mp3');
  // Write a minimal valid MP3 (just the ID3 header + some MPEG frame)
  const mp3Header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ID3v2.4 header
    0xFF, 0xFB, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // MPEG frame
    ...new Array(400).fill(0) // padding
  ]);
  fs.writeFileSync(testMp3Path, mp3Header);
  
  await soundInput.setInputFiles(testMp3Path);
  await page.waitForTimeout(300);
  await page.locator('.hotspot-confirm').click();
  await page.waitForTimeout(500);
  console.log('Sound set for first scene');

  // Export
  let zipPath = null;
  const dlPromise = page.waitForEvent('download');
  page.on('dialog', d => d.accept());
  await page.locator('#export-btn').click();
  const dl = await dlPromise;
  zipPath = path.join(os.tmpdir(), 'test-new-sound.zip');
  await dl.saveAs(zipPath);
  console.log('Downloaded:', fs.statSync(zipPath).size, 'bytes');

  // Check sound in exported ZIP
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const soundFiles = Object.keys(zip.files).filter(k => k.includes('sounds/') && !zip.files[k].dir);
  console.log('Sound files:', soundFiles);
  for (const sf of soundFiles) {
    const data = await zip.files[sf].async('uint8array');
    const isValid = (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) || (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0);
    console.log(sf, '→', data.length, 'bytes, valid MP3:', isValid, 'first bytes:', Array.from(data.slice(0,4)));
  }

  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
