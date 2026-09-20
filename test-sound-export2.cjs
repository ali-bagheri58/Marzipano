const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() !== 'log') console.log('CONSOLE:', m.type(), m.text().slice(0,100)); });

  await page.goto('http://localhost:5174/');
  await page.waitForLoadState('networkidle');
  await page.locator('#file-input').setInputFiles('C:/Users/Aliba/Downloads/IMG_20260218_171811_00_007.zip');
  await page.waitForFunction(() => { const s = document.querySelector('#status'); return !s || s.innerHTML === ''; }, { timeout: 60000 });
  console.log('ZIP loaded');

  // Check hotspot sound data in panoramaHotspots
  const hotspotData = await page.evaluate(() => {
    // Check via exported targets - we need to access module internals
    // Let's check the files list items
    const items = Array.from(document.querySelectorAll('#files .file-item'));
    return items.length + ' items in sidebar';
  });
  console.log(hotspotData);

  // Patch fetch to detect what gets fetched during export
  await page.evaluate(() => {
    window._fetchLog = [];
    const orig = window.fetch;
    window.fetch = async function(url, ...args) {
      if (typeof url === 'string' && (url.startsWith('blob:') || url.includes('sound') || url.includes('mp3'))) {
        window._fetchLog.push({ url: url.slice(0, 80), time: Date.now() });
      }
      return orig.call(this, url, ...args);
    };
  });

  let zipPath = null;
  const dlPromise = page.waitForEvent('download');
  page.on('dialog', d => d.accept());
  await page.locator('#export-btn').click();
  const dl = await dlPromise;
  zipPath = path.join(os.tmpdir(), 'test2.zip');
  await dl.saveAs(zipPath);
  console.log('Downloaded:', fs.statSync(zipPath).size, 'bytes');

  const fetchLog = await page.evaluate(() => window._fetchLog || []);
  console.log('Fetch log during export:', JSON.stringify(fetchLog));

  // Parse ZIP
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  
  for (const key of ['app-files/sounds/IMG_20260218_171811_00_007/hotspot-1.mp3', 
                      'app-files/sounds/IMG_20260218_171811_00_007/hotspot-2.mp3']) {
    if (zip.files[key]) {
      const data = await zip.files[key].async('uint8array');
      const firstBytes = Array.from(data.slice(0, 8));
      const asStr = firstBytes.map(b => String.fromCharCode(b)).join('');
      console.log(key, '→', data.length, 'bytes, starts with:', asStr);
    }
  }

  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
