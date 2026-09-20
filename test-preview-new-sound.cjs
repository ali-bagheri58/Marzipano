const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('ERR: ' + m.text()); });

  await page.goto('http://localhost:5174/');
  await page.waitForLoadState('networkidle');
  await page.locator('#file-input').setInputFiles('C:/Users/Aliba/Downloads/IMG_20260218_171811_00_007_jpg (2).zip');
  await page.waitForFunction(() => { const s = document.querySelector('#status'); return !s || s.innerHTML === ''; }, { timeout: 60000 });
  console.log('ZIP loaded');

  // Add a hotspot sound via properties
  await page.locator('#files .file-item').first().locator('.scene-properties-btn').click();
  await page.waitForSelector('.hotspot-dialog', { timeout: 5000 });

  // Create a valid test MP3
  const testMp3 = path.join(os.tmpdir(), 'test.mp3');
  const mp3 = Buffer.alloc(512);
  mp3[0] = 0xFF; mp3[1] = 0xFB; mp3[2] = 0x90; mp3[3] = 0x00; // MPEG frame
  fs.writeFileSync(testMp3, mp3);

  await page.locator('.scene-sound-input').setInputFiles(testMp3);
  await page.waitForTimeout(300);
  const soundStatus = await page.locator('.scene-sound-status').textContent();
  console.log('Sound status:', soundStatus);
  await page.locator('.hotspot-confirm').click();
  await page.waitForTimeout(300);

  // Now click preview
  const previewErrors = [];
  const [previewPage] = await Promise.all([
    ctx.waitForEvent('page'),
    page.locator('#preview-btn').click()
  ]);
  previewPage.on('pageerror', e => previewErrors.push('PREV: ' + e.message));
  previewPage.on('console', m => { if (m.type() === 'error') previewErrors.push('PREV_ERR: ' + m.text()); });

  await previewPage.waitForLoadState('load');
  await previewPage.waitForTimeout(3000);

  const canvasCount = await previewPage.locator('canvas').count();
  console.log('Canvas count:', canvasCount);
  console.log('Main errors:', errors);
  console.log('Preview errors:', previewErrors);

  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
