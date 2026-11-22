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

test('refuses unavailable playlist items instead of shifting their positions', () => {
  assert.throws(() => resolveNextPlaylistOffset({
    playlistTracks: [tracks[0], null, tracks[1]],
    currentTrackUri: tracks[0].uri,
    upcomingTracks: [tracks[1]]
  }), /unavailable/);
});
