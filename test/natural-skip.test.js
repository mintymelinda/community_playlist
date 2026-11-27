import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, QueueStore } from '../src/lib/queue-store.js';
import { PlaybackCoordinator } from '../src/playback/coordinator.js';
import { SpotifyClient } from '../src/spotify/client.js';

const playlistUri = 'spotify:playlist:playlist1';
const deviceId = 'device-1';
const currentTrack = {
  uri: 'spotify:track:current',
  duration_ms: 180000,
  name: 'Natural track'
};

function createCoordinator({ waiting = false } = {}) {
  const playback = {
    device: { id: deviceId },
    context: { type: 'playlist', uri: playlistUri },
    item: currentTrack,
    is_playing: true,
    progress_ms: 30000
  };
  const calls = [];
  const spotify = {
    async getPlaybackState() { return structuredClone(playback); },
    async skipToNext(targetDevice) { calls.push(targetDevice); }
  };
  const store = new QueueStore(new MemoryStorage());
  if (waiting) {
    store.update(state => {
      state.pending.push({ id: 'viewer-request', uri: 'spotify:track:requested' });
      state.snapshot = {
        playlistUri,
        deviceId,
        currentTrackUri: currentTrack.uri,
        nextTrackUri: 'spotify:track:next',
        nextOffset: 1,
        playlistLength: 3,
        capturedAt: Date.now()
      };
      state.mode = 'waiting-for-playlist';
    });
  }
  const coordinator = new PlaybackCoordinator({
    spotify,
    store,
    playlistUri,
    playlistId: 'playlist1',
    timers: { setInterval() { return 1; }, clearInterval() {} },
    logger: { info() {}, warn() {}, error() {} }
  });
  return { coordinator, store, calls };
}

test('!skip advances an ordinary Spotify playlist track when no viewer request is active', async () => {
  const { coordinator, calls, store } = createCoordinator();

  assert.equal(await coordinator.skip(), true);
  assert.deepEqual(calls, [deviceId]);
  assert.equal(store.get().mode, 'idle');
});

test('!skip advances the natural playlist track while viewer requests are waiting', async () => {
  const { coordinator, calls, store } = createCoordinator({ waiting: true });

  assert.equal(await coordinator.skip(), true);
  assert.deepEqual(calls, [deviceId]);
  assert.equal(store.get().mode, 'waiting-for-playlist');
  assert.deepEqual(store.get().pending.map(item => item.id), ['viewer-request']);
});

test('SpotifyClient sends the Connect skip-to-next command to the selected device', async () => {
  let request;
  const client = new SpotifyClient({
    auth: { getAccessToken: async () => 'access' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    }
  });

  await client.skipToNext(deviceId);

  assert.equal(request.url, 'https://api.spotify.com/v1/me/player/next?device_id=device-1');
  assert.equal(request.options.method, 'POST');
});
