import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaylistItem, normalizeSpotifyTrack, parseSpotifyTrackInput } from '../src/lib/spotify-track.js';

test('parses Spotify track URIs and URLs', () => {
  assert.deepEqual(parseSpotifyTrackInput('spotify:track:abc123'), { id: 'abc123', uri: 'spotify:track:abc123' });
  assert.deepEqual(parseSpotifyTrackInput('https://open.spotify.com/track/abc123?si=token'), { id: 'abc123', uri: 'spotify:track:abc123' });
});

test('leaves text search inputs for the API resolver', () => {
  assert.equal(parseSpotifyTrackInput('Song Name Artist Name'), null);
});

test('rejects non-track Spotify links', () => {
  assert.throws(() => parseSpotifyTrackInput('https://open.spotify.com/playlist/abc123'), /Only Spotify track links/);
});

test('normalizes valid tracks and rejects unplayable items', () => {
  assert.equal(normalizeSpotifyTrack({ id: '1', uri: 'spotify:track:1', name: 'Song', artists: [{ name: 'Artist' }] }).name, 'Song');
  assert.equal(normalizeSpotifyTrack({ id: '1', uri: 'spotify:track:1', is_playable: false }), null);
  assert.equal(normalizePlaylistItem({ item: { id: '2', uri: 'spotify:track:2', name: 'Nested' } }).name, 'Nested');
});
