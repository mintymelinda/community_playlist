import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveE2ESuite, playbackTrackUri } from '../src/e2e/live-suite.js';
import { MemoryStorage, QueueStore } from '../src/lib/queue-store.js';

const playlistUri = 'spotify:playlist:target-playlist';
const deviceId = 'connect-device';
const tracks = [
  null,
  { id: 'a', uri: 'spotify:track:a', name: 'A', type: 'track' },
  { id: 'b', uri: 'spotify:track:b', name: 'B', type: 'track' },
  { id: 'c', uri: 'spotify:track:c', name: 'C', type: 'track' }
];
const testX = { id: 'x', uri: 'spotify:track:x', name: 'X', duration_ms: 180000 };
const testY = { id: 'y', uri: 'spotify:track:y', name: 'Y', duration_ms: 180000 };

function createApp({
  configuredPlaylist = playlistUri,
  initialContext = 'spotify:album:other',
  isPlaying = true,
  shuffle = true,
  repeat = 'context',
  resolvedX = testX,
  resolvedY = testY,
  currentTrackUri = tracks[1].uri,
  nextTrackUri = tracks[2].uri
} = {}) {
  const playback = {
    device: { id: deviceId },
    context: initialContext ? {
      type: initialContext.startsWith('spotify:playlist:') ? 'playlist' : 'album',
      uri: initialContext
    } : null,
    item: tracks[1],
    is_playing: isPlaying,
    shuffle_state: shuffle,
    repeat_state: repeat,
    progress_ms: 12000
  };
  const calls = [];
  const spotify = {
    async getPlaybackState() { return structuredClone(playback); },
    async getDevices() { return [{ id: deviceId, is_active: true }]; },
    async getPlaylistItems(id) {
      calls.push({ method: 'getPlaylistItems', id });
      return tracks;
    },
    async getQueue() { return [tracks[2], tracks[3]]; },
    async resolveTrack(input) { return input === 'test-x' ? resolvedX : resolvedY; },
    extractPlaylistId(uri) { return uri.split(':').at(-1); },
    async setShuffle(enabled, targetDevice) {
      calls.push({ method: 'setShuffle', enabled, targetDevice });
      playback.shuffle_state = enabled;
    },
    async setRepeat(mode, targetDevice) {
      calls.push({ method: 'setRepeat', mode, targetDevice });
      playback.repeat_state = mode;
    },
    async playPlaylistAt(uri, offset, targetDevice) {
      calls.push({ method: 'playPlaylistAt', uri, offset, targetDevice });
      playback.context = { type: 'playlist', uri };
      playback.device = { id: targetDevice };
      playback.item = tracks[offset];
      playback.is_playing = true;
    },
    async resumePlayback(targetDevice) {
      calls.push({ method: 'resumePlayback', targetDevice });
      playback.is_playing = true;
    }
  };
  const store = new QueueStore(new MemoryStorage(), 'isolated-e2e-queue', 10);
  store.enqueue({ id: 'stale-test-request', uri: testX.uri });
  const app = {
    config: {
      playlistUri: configuredPlaylist,
      spotifyDeviceId: '',
      e2eTrackX: 'test-x',
      e2eTrackY: 'test-y'
    },
    started: true,
    eventSub: { socket: { readyState: 1 } },
    powerUp: { id: 'power-up' },
    broadcasterId: 'broadcaster',
    twitchAuth: { async validate() { return { user_id: 'broadcaster' }; } },
    spotify,
    store,
    playlistUri: configuredPlaylist,
    playlistId: configuredPlaylist ? 'target-playlist' : '',
    coordinator: {
      playlistUri: configuredPlaylist,
      playlistId: configuredPlaylist ? 'target-playlist' : '',
      async captureSnapshot() {
        return {
          playlistUri: this.playlistUri,
          deviceId,
          currentTrackUri,
          nextOffset: 2,
          nextTrackUri,
          playlistLength: tracks.length,
          capturedAt: Date.now()
        };
      }
    }
  };
  return { app, calls, playback };
}

test('preflight loads the selected playlist, starts it, clears only the E2E request store, and restores shuffle/repeat', async () => {
  const { app, calls, playback } = createApp();
  const suite = createLiveE2ESuite(app);

  const result = await suite.preflight();

  assert.equal(app.coordinator.playlistUri, playlistUri);
  assert.equal(app.coordinator.playlistId, 'target-playlist');
  assert.equal(result.playlistUri, playlistUri);
  assert.equal(playback.context.uri, playlistUri);
  assert.equal(playback.is_playing, true);
  assert.equal(playback.shuffle_state, false);
  assert.equal(playback.repeat_state, 'off');
  assert.equal(app.store.get().pending.length, 0);
  assert.deepEqual(calls.find(call => call.method === 'playPlaylistAt'), {
    method: 'playPlaylistAt',
    uri: playlistUri,
    offset: 1,
    targetDevice: deviceId
  });

  await suite.restorePlaybackSettings();
  assert.equal(playback.shuffle_state, true);
  assert.equal(playback.repeat_state, 'context');
});

test('preflight uses the active playlist when no playlist URI is configured and resumes it if paused', async () => {
  const { app, calls, playback } = createApp({
    configuredPlaylist: '',
    initialContext: playlistUri,
    isPlaying: false,
    shuffle: false,
    repeat: 'off'
  });
  const suite = createLiveE2ESuite(app);

  const result = await suite.preflight();

  assert.equal(result.playlistUri, playlistUri);
  assert.equal(app.playlistUri, playlistUri);
  assert.equal(playback.is_playing, true);
  assert.equal(calls.some(call => call.method === 'resumePlayback'), true);
  assert.equal(calls.some(call => call.method === 'playPlaylistAt'), false);

  await suite.restorePlaybackSettings();
  assert.equal(playback.shuffle_state, false);
  assert.equal(playback.repeat_state, 'off');
});

test('preflight allows both viewer requests to be the same Spotify track', async () => {
  const { app } = createApp({ resolvedY: testX });
  const suite = createLiveE2ESuite(app);

  const result = await suite.preflight();

  assert.equal(result.trackX.uri, testX.uri);
  assert.equal(result.trackY.uri, testX.uri);
  await suite.restorePlaybackSettings();
});

test('preflight allows viewer requests that are already in the playlist, including its current and next tracks', async () => {
  const currentTrack = { ...tracks[1], duration_ms: 180000 };
  const nextTrack = { ...tracks[2], duration_ms: 180000 };
  const { app } = createApp({
    resolvedX: currentTrack,
    resolvedY: nextTrack,
    currentTrackUri: currentTrack.uri,
    nextTrackUri: nextTrack.uri
  });
  const suite = createLiveE2ESuite(app);

  const result = await suite.preflight();

  assert.equal(result.trackX.uri, currentTrack.uri);
  assert.equal(result.trackY.uri, nextTrack.uri);
  await suite.restorePlaybackSettings();
});

test('preflight requires a configured or currently loaded playlist context', async () => {
  const { app } = createApp({ configuredPlaylist: '', initialContext: null });
  const suite = createLiveE2ESuite(app);
  await assert.rejects(suite.preflight(), /set SPOTIFY_PLAYLIST_URI or start a Spotify playlist first/i);
});

test('matches Spotify relinked playback to the originally requested track URI', () => {
  const playback = {
    item: {
      uri: 'spotify:track:playable-replacement',
      linked_from: { uri: 'spotify:track:original-request' }
    }
  };

  assert.equal(playbackTrackUri(playback), 'spotify:track:original-request');
  assert.equal(playbackTrackUri({ item: { uri: 'spotify:track:ordinary' } }), 'spotify:track:ordinary');
  assert.equal(playbackTrackUri(null), null);
});
