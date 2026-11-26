export function resolveNextPlaylistOffset({ playlistTracks, currentTrackUri, upcomingTracks, shuffle = false }) {
  if (!Array.isArray(playlistTracks) || !playlistTracks.length) {
    throw new Error('The configured Spotify playlist has no readable items.');
  }

  const currentIndices = [];
  playlistTracks.forEach((track, index) => {
    if (track?.uri === currentTrackUri) currentIndices.push(index);
  });
  if (!currentIndices.length) {
    throw new Error('The currently playing item is not in the configured playlist.');
  }

  const queueItems = Array.isArray(upcomingTracks) ? upcomingTracks : [];
  if (queueItems.some(item => !item?.uri)) {
    throw new Error('Spotify upcoming queue contains an item without a usable URI. Refusing to interrupt playback.');
  }
  const queueUris = queueItems.map(item => item.uri);
  const playlistUris = new Set(playlistTracks.map(item => item?.uri).filter(Boolean));

  if (shuffle) {
    if (!queueUris.length) {
      throw new Error('Spotify upcoming queue does not identify the next shuffled playlist item. Refusing to interrupt playback.');
    }
    if (queueUris.some(uri => !playlistUris.has(uri))) {
      throw new Error('Spotify upcoming queue contains items outside the configured playlist. Refusing to interrupt playback.');
    }

    const nextTrackUri = queueUris[0];
    const nextIndices = [];
    playlistTracks.forEach((item, index) => {
      if (item?.uri === nextTrackUri) nextIndices.push(index);
    });
    if (nextIndices.length !== 1) {
      throw new Error('The next shuffled item occurs more than once in the playlist and its restore position is ambiguous.');
    }

    return {
      nextOffset: nextIndices[0],
      nextTrackUri
    };
  }

  const valid = currentIndices.map(index => {
    const remaining = playlistTracks
      .map((item, playlistIndex) => ({ item, playlistIndex }))
      .slice(index + 1)
      .filter(entry => entry.item?.uri);

    if (!remaining.length) {
      return queueUris.length === 0 ? { remaining } : null;
    }
    if (!queueUris.length || queueUris.length > remaining.length) return null;
    const matches = queueUris.every((uri, offset) => remaining[offset]?.item.uri === uri);
    return matches ? { remaining } : null;
  }).filter(Boolean);

  if (valid.length !== 1) {
    if (!valid.length) {
      throw new Error('Spotify upcoming queue does not match the configured playlist continuation. Refusing to interrupt playback.');
    }
    throw new Error('The current item occurs more than once in the playlist and its next position is ambiguous.');
  }

  const next = valid[0].remaining[0];
  return {
    nextOffset: next?.playlistIndex ?? playlistTracks.length,
    nextTrackUri: next?.item.uri || null
  };
}
