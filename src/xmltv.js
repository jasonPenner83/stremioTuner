export function toXmltvDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildXmltv(channels) {
  const channelTags = channels
    .map((ch) => `  <channel id="${escapeXml(ch.id)}">\n    <display-name>${escapeXml(ch.name)}</display-name>\n  </channel>`)
    .join('\n');

  const programmeTags = channels
    .flatMap((ch) => (ch.schedule?.items || []).map((item) => (
      `  <programme start="${toXmltvDate(item.start)}" stop="${toXmltvDate(item.end)}" channel="${escapeXml(ch.id)}">\n    <title>${escapeXml(item.title)}</title>\n  </programme>`
    )))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channelTags}\n${programmeTags}\n</tv>\n`;
}
