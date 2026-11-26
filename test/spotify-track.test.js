import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaylistItem, normalizeSpotifyTrack, parseSpotifyPlaylistInput, parseSpotifyTrackInput } from '../src/lib/spotify-track.js';

test('parses Spotify track URIs and URLs', () => {
  assert.deepEqual(parseSpotifyTrackInput('spotify:track:abc123'), { id: 'abc123', uri: 'spotify:track:abc123' });
  assert.deepEqual(parseSpotifyTrackInput('https://open.spotify.com/track/abc123?si=token'), { id: 'abc123', uri: 'spotify:track:abc123' });
});

test('parses bare Spotify track IDs and playlist IDs', () => {
  const trackId = '4EISOJDYezvr8UtIeOy3sj';
  const playlistId = '7IS0sJMyOz3XAhqRxkOwkC';
  assert.deepEqual(parseSpotifyTrackInput(trackId), {
    id: trackId,
    uri: 'spotify:track:' + trackId
  });
  assert.deepEqual(parseSpotifyPlaylistInput(playlistId), {
    id: playlistId,
    uri: 'spotify:playlist:' + playlistId
  });
  assert.deepEqual(parseSpotifyPlaylistInput('https://open.spotify.com/playlist/' + playlistId), {
    id: playlistId,
    uri: 'spotify:playlist:' + playlistId
  });
});

test('leaves text search inputs for the API resolver', () => {
  assert.equal(parseSpotifyTrackInput('Song Name Artist Name'), null);
});

test('rejects non-track Spotify links', () => {
  assert.throws(() => parseSpotifyTrackInput('https://open.spotify.com/playlist/abc123'), /Only Spotify track links/);
});

test('normalizes requested tracks and keeps supported playlist episodes', () => {
  assert.equal(normalizeSpotifyTrack({ id: '1', uri: 'spotify:track:1', name: 'Song', artists: [{ name: 'Artist' }] }).name, 'Song');
  assert.equal(normalizeSpotifyTrack({ id: '1', uri: 'spotify:track:1', is_playable: false }), null);
  assert.equal(normalizePlaylistItem({ item: { id: '2', uri: 'spotify:track:2', name: 'Nested' } }).name, 'Nested');
  assert.deepEqual(normalizePlaylistItem({
    item: { id: 'episode-1', uri: 'spotify:episode:episode-1', type: 'episode', name: 'Podcast', duration_ms: 120000 }
  }), {
    id: 'episode-1',
    uri: 'spotify:episode:episode-1',
    type: 'episode',
    name: 'Podcast',
    artists: [],
    durationMs: 120000
  });
});

test('preserves unavailable and local playlist positions as null placeholders', () => {
  assert.equal(normalizePlaylistItem({ item: null }), null);
  assert.equal(normalizePlaylistItem({
    item: { id: 'restricted', uri: 'spotify:track:restricted', type: 'track', is_playable: false }
  }), null);
  assert.equal(normalizePlaylistItem({
    is_local: true,
    item: { uri: 'spotify:local:artist:album:title:123', type: 'track' }
  }), null);
});
