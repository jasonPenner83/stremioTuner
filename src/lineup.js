export function buildRandomStartLineup(items, rng = Math.random) {
  if (items.length === 0) return [];
  const startIndex = Math.floor(rng() * items.length);
  return [...items.slice(startIndex), ...items.slice(0, startIndex)];
}

export function buildRandomLineup(items, count, rng = Math.random) {
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.floor(rng() * items.length);
    result.push(items[index]);
  }
  return result;
}
