const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('ERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:5174/');
  await page.waitForLoadState('networkidle');
  await page.locator('#file-input').setInputFiles('C:/Users/Aliba/Downloads/IMG_20260218_171811_00_007.zip');
  await page.waitForFunction(() => { const s = document.querySelector('#status'); return !s || s.innerHTML === ''; }, { timeout: 60000 });
  console.log('ZIP loaded');

  // Open floor plan editor and add a floor plan
  await page.locator('#floorplan-btn').click();
  await page.waitForSelector('.fp-dialog', { timeout: 5000 });
  console.log('Floor plan editor opened');

  // Load floor plan image
  await page.locator('#fp-file-input').setInputFiles('C:/Users/Aliba/My Project/360 Pic/FloorPlan.png');
  await page.waitForTimeout(500);

  // Save
  await page.locator('#fp-save-btn').click();
  await page.waitForTimeout(300);
  console.log('Floor plan saved');

  // Check floorPlanFile state
  const fpState = await page.evaluate(() => ({
    hasFpFile: !!window.floorPlanFile,
    fpHotspots: window.floorPlanHotspots
  }));
  console.log('Floor plan state (module scope - may be undefined):', fpState);

  // Open preview
  const [previewPage] = await Promise.all([
    ctx.waitForEvent('page'),
    page.locator('#preview-btn').click()
  ]);
  const previewErrors = [];
  previewPage.on('pageerror', e => previewErrors.push('PREV: ' + e.message));
  previewPage.on('console', m => { if (m.type() === 'error') previewErrors.push('PREV_ERR: ' + m.text()); });

  await previewPage.waitForLoadState('load');
  await previewPage.waitForTimeout(3000);

  // Check floor plan in preview
  const fpInPreview = await previewPage.evaluate(() => ({
    hasFab: !!document.querySelector('.fp-fab'),
    hasPanel: !!document.querySelector('.fp-panel'),
    fpImgSrc: document.querySelector('.fp-plan-img')?.src?.slice(0, 60) || 'not found',
    fpImgComplete: document.querySelector('.fp-plan-img')?.complete,
    fpPinsCount: document.querySelectorAll('.fp-plan-pin').length,
    hasFloorplanScript: Array.from(document.querySelectorAll('script')).some(s => s.src.includes('floorplan'))
  }));
  console.log('Floor plan in preview:', JSON.stringify(fpInPreview, null, 2));

  // Click the FAB
  if (fpInPreview.hasFab) {
    await previewPage.locator('.fp-fab').click();
    await previewPage.waitForTimeout(500);
    const panelOpen = await previewPage.locator('.fp-panel.is-open').isVisible();
    console.log('Panel opened after click:', panelOpen);
    const imgVisible = await previewPage.locator('.fp-plan-img').isVisible().catch(() => false);
    console.log('Image visible:', imgVisible);
  }

  console.log('Errors:', [...errors, ...previewErrors]);
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
