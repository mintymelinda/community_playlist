export function resolveNextPlaylistOffset({ playlistTracks, currentTrackUri, upcomingTracks, shuffle = false }) {
  if (!Array.isArray(playlistTracks) || !playlistTracks.length) {
    throw new Error('The configured Spotify playlist has no readable tracks.');
  }
  if (playlistTracks.some(track => !track?.uri)) {
    throw new Error('The playlist contains unavailable or unsupported items. Resolve those playlist entries before enabling requests.');
  }

  const currentIndices = [];
  playlistTracks.forEach((track, index) => {
    if (track.uri === currentTrackUri) currentIndices.push(index);
  });
  if (!currentIndices.length) {
    throw new Error('The currently playing track is not in the configured playlist.');
  }

  const queueItems = Array.isArray(upcomingTracks) ? upcomingTracks : [];
  if (shuffle) {
    if (!queueItems.length || queueItems.some(track => !track?.uri)) {
      throw new Error('Spotify upcoming queue does not identify the next shuffled playlist track. Refusing to interrupt playback.');
    }

    const playlistUris = new Set(playlistTracks.map(track => track.uri));
    const queueUris = queueItems.map(track => track.uri);
    if (queueUris.some(uri => !playlistUris.has(uri))) {
      throw new Error('Spotify upcoming queue contains tracks outside the configured playlist. Refusing to interrupt playback.');
    }

    const nextTrackUri = queueUris[0];
    const nextIndices = [];
    playlistTracks.forEach((track, index) => {
      if (track.uri === nextTrackUri) nextIndices.push(index);
    });
    if (nextIndices.length !== 1) {
      throw new Error('The next shuffled track occurs more than once in the playlist and its restore position is ambiguous.');
    }

    return {
      nextOffset: nextIndices[0],
      nextTrackUri
    };
  }

  const queueUris = queueItems.map(track => track?.uri).filter(Boolean);
  const valid = currentIndices.filter(index => {
    const remaining = playlistTracks.slice(index + 1);
    if (!remaining.length) return queueUris.length === 0;
    if (!queueUris.length || queueUris.length > remaining.length) return false;
    return queueUris.every((uri, offset) => remaining[offset]?.uri === uri);
  });

  if (valid.length !== 1) {
    if (!valid.length) {
      throw new Error('Spotify upcoming queue does not match the configured playlist continuation. Refusing to interrupt playback.');
    }
    throw new Error('The current track occurs more than once in the playlist and its next position is ambiguous.');
  }

  const nextOffset = valid[0] + 1;
  return {
    nextOffset,
    nextTrackUri: playlistTracks[nextOffset]?.uri || null
  };
}
