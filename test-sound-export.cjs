const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('ERR:', e.message));

  await page.goto('http://localhost:5174/');
  await page.waitForLoadState('networkidle');
  await page.locator('#file-input').setInputFiles('C:/Users/Aliba/Downloads/IMG_20260218_171811_00_007.zip');
  await page.waitForFunction(() => { const s = document.querySelector('#status'); return !s || s.innerHTML === ''; }, { timeout: 60000 });
  console.log('ZIP loaded');

  // Download export
  let zipPath = null;
  const downloadPromise = page.waitForEvent('download');
  page.on('dialog', d => d.accept());
  await page.locator('#export-btn').click();
  const download = await downloadPromise;
  zipPath = path.join(os.tmpdir(), 'test-export-sound.zip');
  await download.saveAs(zipPath);
  console.log('Downloaded ZIP:', fs.statSync(zipPath).size, 'bytes');

  // Parse ZIP and check sound files
  const JSZip = require('jszip');
  const zipBuf = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(zipBuf);

  const soundFiles = Object.keys(zip.files).filter(k => k.includes('sounds/'));
  console.log('Sound files in ZIP:', soundFiles);

  for (const sf of soundFiles) {
    const data = await zip.files[sf].async('uint8array');
    console.log(sf, '→', data.length, 'bytes, first 4 bytes:', Array.from(data.slice(0,4)));
    // Check if it's a valid MP3 (starts with ID3 or 0xFF 0xFB etc.)
    const isValidMp3 = (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) || // ID3
                       (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0); // MPEG sync
    console.log('  Valid MP3:', isValidMp3);
  }

  // Check data.js for sound references
  const dataJs = await zip.files['app-files/data.js'].async('string');
  const soundRefs = dataJs.match(/"url":\s*"sounds\/[^"]+"/g);
  console.log('Sound refs in data.js:', soundRefs);

  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
