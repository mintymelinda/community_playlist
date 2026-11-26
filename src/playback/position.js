export function resolveNextPlaylistOffset({ playlistTracks, currentTrackUri, upcomingTracks, shuffle = false }) {
  if (!Array.isArray(playlistTracks) || !playlistTracks.length) {
    throw new Error('The configured Spotify playlist has no readable items.');
  }

  const currentIndices = [];
  playlistTracks.forEach((item, index) => {
    if (item?.uri === currentTrackUri) currentIndices.push(index);
  });

  const queueItems = Array.isArray(upcomingTracks) ? upcomingTracks : [];
  if (queueItems.some(item => !item?.uri)) {
    throw new Error('Spotify upcoming queue contains an item without a usable URI. Refusing to interrupt playback.');
  }
  const queueUris = queueItems.map(item => item.uri);
  const playlistUris = new Set(playlistTracks.map(item => item?.uri).filter(Boolean));

  // When shuffle is enabled, Spotify's queue order is authoritative. The first
  // queued item identifies the playlist offset to restore, but only if that
  // item occurs once and the queue contains no manually queued foreign items.
  if (shuffle) {
    if (!queueUris.length) {
      if (currentIndices.length === 1) {
        const hasPlayableRemainder = playlistTracks
          .slice(currentIndices[0] + 1)
          .some(item => item?.uri);
        if (!hasPlayableRemainder) {
          return { nextOffset: playlistTracks.length, nextTrackUri: null };
        }
      }
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
      throw new Error('The next shuffled item occurs more than once in the playlist or cannot be placed after the current item. Its restore position is ambiguous.');
    }

    return {
      nextOffset: nextIndices[0],
      nextTrackUri
    };
  }

  // With shuffle off, find the playlist offset whose playable suffix matches
  // Spotify's full upcoming queue. This does not require the current playback
  // URI itself to match the playlist: Spotify can report a relinked/alternate
  // current item while the playlist context and continuation remain valid.
  if (queueUris.length) {
    const candidates = [];
    playlistTracks.forEach((item, index) => {
      if (item?.uri !== queueUris[0]) return;
      if (currentIndices.length && !currentIndices.some(currentIndex => currentIndex < index)) return;

      const remaining = playlistTracks
        .map((playlistItem, playlistIndex) => ({ item: playlistItem, playlistIndex }))
        .slice(index)
        .filter(entry => entry.item?.uri);
      if (queueUris.length > remaining.length) return;
      const matches = queueUris.every((uri, offset) => remaining[offset]?.item.uri === uri);
      if (matches) candidates.push({ nextOffset: index, nextTrackUri: item.uri });
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error('Spotify upcoming queue matches more than one playlist position. Refusing to interrupt playback.');
    }
    throw new Error('Spotify upcoming queue does not match an unambiguous continuation of the configured playlist. Refusing to interrupt playback.');
  }

  // An empty queue is only safe to interpret as end-of-playlist when the
  // current item has one known playlist position and nothing playable follows.
  if (currentIndices.length === 1) {
    const hasPlayableRemainder = playlistTracks
      .slice(currentIndices[0] + 1)
      .some(item => item?.uri);
    if (!hasPlayableRemainder) {
      return { nextOffset: playlistTracks.length, nextTrackUri: null };
    }
  }

  throw new Error('Spotify upcoming queue does not identify the next playlist item, and the current item cannot establish an unambiguous end position.');
}
