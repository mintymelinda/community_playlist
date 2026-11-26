import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNextPlaylistOffset } from '../src/playback/position.js';

const tracks = ['a', 'b', 'c', 'd'].map(id => ({ uri: 'spotify:track:' + id }));

test('resolves the next playlist offset from the matching upcoming queue', () => {
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:a',
    upcomingTracks: tracks.slice(1)
  }), { nextOffset: 1, nextTrackUri: 'spotify:track:b' });
});

test('uses the upcoming queue when Spotify reports a current URI not present in the playlist', () => {
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:relinked-current',
    upcomingTracks: tracks.slice(1)
  }), { nextOffset: 1, nextTrackUri: 'spotify:track:b' });
});

test('uses the first upcoming playlist item when shuffle is enabled and current URI differs', () => {
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:relinked-current',
    upcomingTracks: [tracks[2], tracks[3], tracks[1]],
    shuffle: true
  }), { nextOffset: 2, nextTrackUri: 'spotify:track:c' });
});

test('resolves the next playlist offset from Spotify queue order when shuffle is enabled', () => {
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:a',
    upcomingTracks: [tracks[2], tracks[3], tracks[1]],
    shuffle: true
  }), { nextOffset: 2, nextTrackUri: 'spotify:track:c' });
});

test('rejects a shuffled queue containing an item outside the configured playlist', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:a',
    upcomingTracks: [tracks[2], { uri: 'spotify:track:manual' }],
    shuffle: true
  }), /outside the configured playlist/);
});

test('rejects a shuffled next track with duplicate playlist positions', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], tracks[1], tracks[2], tracks[2]],
    currentTrackUri: 'spotify:track:a',
    upcomingTracks: [tracks[2], tracks[1]],
    shuffle: true
  }), /restore position is ambiguous/);
});

test('rejects a manually modified queue before interrupting playback', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:a',
    upcomingTracks: [{ uri: 'spotify:track:x' }, tracks[1]]
  }), /does not match/);
});

test('rejects manual queue entries appended after the first few playlist tracks', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: tracks,
    currentTrackUri: 'spotify:track:a',
    upcomingTracks: [tracks[1], tracks[2], tracks[3], { uri: 'spotify:track:manual' }]
  }), /does not match/);
});

test('rejects an ambiguous queue match when the current item cannot narrow duplicate positions', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], tracks[1], tracks[2], tracks[1], tracks[2]],
    currentTrackUri: 'spotify:track:unknown',
    upcomingTracks: [tracks[1], tracks[2]]
  }), /more than one playlist position/);
});

test('uses the queue to disambiguate repeated tracks', () => {
  const repeated = [tracks[0], tracks[1], tracks[0], tracks[2]];
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: repeated,
    currentTrackUri: tracks[0].uri,
    upcomingTracks: [tracks[2]]
  }), { nextOffset: 3, nextTrackUri: tracks[2].uri });
});

test('refuses ambiguous duplicate positions', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], tracks[1], tracks[0], tracks[1]],
    currentTrackUri: tracks[0].uri,
    upcomingTracks: []
  }), /ambiguous|continuation/);
});

test('skips unavailable playlist placeholders while retaining the original restore offset', () => {
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], null, tracks[1], tracks[2]],
    currentTrackUri: tracks[0].uri,
    upcomingTracks: [tracks[1], tracks[2]]
  }), { nextOffset: 2, nextTrackUri: tracks[1].uri });
});

test('supports an episode as the next item in the playlist continuation', () => {
  const episode = { uri: 'spotify:episode:podcast-1', type: 'episode' };
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], episode, tracks[1]],
    currentTrackUri: tracks[0].uri,
    upcomingTracks: [episode, tracks[1]]
  }), { nextOffset: 1, nextTrackUri: episode.uri });
});

test('skips unavailable placeholders when resolving a shuffled playlist continuation', () => {
  assert.deepEqual(resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], null, tracks[1], tracks[2], tracks[3]],
    currentTrackUri: tracks[0].uri,
    upcomingTracks: [tracks[3], tracks[2], tracks[1]],
    shuffle: true
  }), { nextOffset: 4, nextTrackUri: tracks[3].uri });
});
