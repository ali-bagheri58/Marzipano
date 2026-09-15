import test from 'node:test';
import assert from 'node:assert/strict';

import { removeHotspotFromMap } from './hotspot-utils.js';

test('removeHotspotFromMap removes the selected hotspot from the current scene', () => {
  const hotspotA = { id: 1, label: 'A' };
  const hotspotB = { id: 2, label: 'B' };
  const map = new Map([['scene-1', [hotspotA, hotspotB]]]);

  const changed = removeHotspotFromMap(map, 'scene-1', hotspotB);

  assert.equal(changed, true);
  assert.deepEqual(map.get('scene-1'), [hotspotA]);
});

test('removeHotspotFromMap returns false when the hotspot is not found', () => {
  const hotspotA = { id: 1, label: 'A' };
  const map = new Map([['scene-1', [hotspotA]]]);

  const changed = removeHotspotFromMap(map, 'scene-1', { id: 99, label: 'Missing' });

  assert.equal(changed, false);
  assert.deepEqual(map.get('scene-1'), [hotspotA]);
});
