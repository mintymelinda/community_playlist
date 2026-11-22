export function parseSpotifyTrackInput(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('The Power-up did not include a song request.');

  const uriMatch = value.match(/^spotify:track:([A-Za-z0-9]+)$/i);
  if (uriMatch) return { id: uriMatch[1], uri: 'spotify:track:' + uriMatch[1] };

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!['open.spotify.com', 'www.open.spotify.com'].includes(url.hostname.toLowerCase())) {
    return null;
  }

  const match = url.pathname.match(/^\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]+)/i);
  if (!match) throw new Error('Only Spotify track links are supported.');
  return { id: match[1], uri: 'spotify:track:' + match[1] };
}

export function normalizeSpotifyTrack(item) {
  if (!item || item.type && item.type !== 'track') return null;
  if (!item.id || !item.uri || item.is_playable === false || item.is_local) return null;
  return {
    id: item.id,
    uri: item.uri,
    name: item.name || 'Unknown track',
    artists: Array.isArray(item.artists) ? item.artists.map(artist => artist.name).filter(Boolean) : [],
    durationMs: Number(item.duration_ms) || 0
  };
}

export function normalizePlaylistItem(entry) {
  const item = entry?.item || entry?.track || entry;
  return normalizeSpotifyTrack(item);
}
