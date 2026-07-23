const QUALITY_ORDER = ['480p', '720p', '1080p', '2160p'];

const LANGUAGE_KEYWORDS = {
  en: ['english'],
  es: ['spanish', 'latino', 'espanol'],
  fr: ['french', 'francais'],
  de: ['german', 'deutsch'],
  it: ['italian', 'italiano'],
  pt: ['portuguese', 'portugues']
};

export function parseQuality(text) {
  const lower = text.toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(lower)) return '2160p';
  for (const q of QUALITY_ORDER) {
    if (q !== '2160p' && lower.includes(q)) return q;
  }
  return null;
}

export function qualityRank(quality) {
  const idx = QUALITY_ORDER.indexOf(quality);
  return idx === -1 ? null : idx;
}

export function parsePeers(text) {
  const emojiMatch = text.match(/👤\s*(\d+)/);
  if (emojiMatch) return Number(emojiMatch[1]);
  const seedMatch = text.match(/(\d+)\s*(?:seeds?|peers?)/i);
  if (seedMatch) return Number(seedMatch[1]);
  return 0;
}

export function matchesLanguage(text, languageCode) {
  const lower = text.toLowerCase();
  const targetKeywords = LANGUAGE_KEYWORDS[languageCode] || [languageCode];
  const otherEntries = Object.entries(LANGUAGE_KEYWORDS).filter(([code]) => code !== languageCode);

  if (targetKeywords.some((kw) => lower.includes(kw))) return true;

  const hasOtherLanguageTag = otherEntries.some(([, keywords]) => keywords.some((kw) => lower.includes(kw)));
  if (hasOtherLanguageTag) return false;

  return languageCode === 'en';
}

function maxByPeers(candidates) {
  return candidates.reduce((best, c) => (c.peers > best.peers ? c : best));
}

export function selectStream(streams, { minQuality, language }) {
  const minRank = qualityRank(minQuality);
  const parsed = streams
    .filter((s) => !!s.url)
    .map((s) => {
      const text = `${s.title || ''} ${s.name || ''}`;
      return {
        url: s.url,
        quality: parseQuality(text),
        peers: parsePeers(text),
        languageOk: matchesLanguage(text, language)
      };
    });

  const strict = parsed.filter((c) => c.languageOk && c.quality !== null && qualityRank(c.quality) >= minRank);
  if (strict.length) return maxByPeers(strict);

  const relaxed = parsed.filter((c) => c.languageOk);
  if (relaxed.length) return maxByPeers(relaxed);

  return null;
}
