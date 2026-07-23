export function buildM3u(channels, baseUrl) {
  const lines = ['#EXTM3U'];
  for (const ch of channels) {
    lines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" group-title="stremioTuner",${ch.name}`);
    lines.push(`${baseUrl}/stream/${ch.id}`);
  }
  return `${lines.join('\n')}\n`;
}
