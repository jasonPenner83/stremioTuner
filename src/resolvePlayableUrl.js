import { rankStreams } from './streamSelect.js';
import { fetchStreams } from './addonClient.js';
import { checkInstantAvailability, resolveStream, parseSeasonEpisode } from './realDebrid.js';
import { isLikelyPlayableSize } from './streamSizeCheck.js';

export async function resolvePlayableUrl({
  item,
  type,
  channel,
  streamSource,
  realDebridApiKey,
  fetchStreamsImpl = fetchStreams,
  checkInstantAvailabilityImpl = checkInstantAvailability,
  resolveStreamImpl = resolveStream,
  isLikelyPlayableSizeImpl = isLikelyPlayableSize
}) {
  const streams = await fetchStreamsImpl(streamSource.transportUrl, type, item.id);

  const direct = streams.filter((s) => !!s.url);
  let magnetCandidates = streams.filter((s) => !!s.infoHash && !s.url);

  if (magnetCandidates.length && realDebridApiKey) {
    try {
      const cached = await checkInstantAvailabilityImpl(realDebridApiKey, magnetCandidates.map((s) => s.infoHash));
      magnetCandidates = magnetCandidates.filter((s) => cached.has(s.infoHash));
    } catch (err) {
      console.error(`Real-Debrid availability check failed: ${err.message}`);
      magnetCandidates = [];
    }
  } else {
    magnetCandidates = [];
  }

  const candidates = rankStreams([...direct, ...magnetCandidates], { minQuality: channel.minQuality, language: channel.language });

  for (const candidate of candidates) {
    if (candidate.url) {
      const playable = await isLikelyPlayableSizeImpl(candidate.url);
      if (playable) return candidate.url;
      console.error(`Direct URL failed size check (likely a takedown placeholder), trying next candidate: ${candidate.url}`);
      continue;
    }
    const { season, episode } = parseSeasonEpisode(item.id);
    try {
      return await resolveStreamImpl(realDebridApiKey, candidate.infoHash, { season, episode });
    } catch (err) {
      console.error(`Real-Debrid resolution failed for a candidate, trying next: ${err.message}`);
    }
  }

  return null;
}
