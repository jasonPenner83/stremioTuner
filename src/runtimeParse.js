export function parseRuntimeMs(runtime) {
  if (!runtime) return null;
  const match = String(runtime).match(/(\d+)/);
  if (!match) return null;
  return Number(match[1]) * 60 * 1000;
}
