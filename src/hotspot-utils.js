export function removeHotspotFromMap(hotspotMap, panoramaKey, hotspot) {
  const list = hotspotMap.get(panoramaKey) || [];
  const nextList = list.filter((entry) => entry !== hotspot && entry?.id !== hotspot?.id);

  if (nextList.length === list.length) return false;

  if (nextList.length) {
    hotspotMap.set(panoramaKey, nextList);
  } else {
    hotspotMap.delete(panoramaKey);
  }

  return true;
}
