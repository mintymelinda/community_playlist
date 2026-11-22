import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, QueueStore } from '../src/lib/queue-store.js';
import { PlaybackCoordinator } from '../src/playback/coordinator.js';

const playlistUri = 'spotify:playlist:playlist1';
const deviceId = 'device-1';
const tracks = ['a', 'b', 'c', 'd'].map(id => ({
  id,
  uri: 'spotify:track:' + id,
  name: id.toUpperCase(),
  duration_ms: 180000,
  durationMs: 180000
}));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeSpotify {
  constructor() {
    this.current = {
      device: { id: deviceId },
      context: { type: 'playlist', uri: playlistUri },
      item: tracks[0],
      is_playing: true,
      shuffle_state: false,
      repeat_state: 'off',
      progress_ms: 12000
    };
    this.played = [];
    this.restored = [];
  }
  async getPlaybackState() { return clone(this.current); }
  async getPlaylistItems() { return tracks; }
  async getQueue() { return tracks.slice(1); }
  async playTrack(uri, targetDevice) {
    this.played.push({ uri, targetDevice });
    const item = tracks.find(track => track.uri === uri) || { uri, id: uri.split(':').at(-1), duration_ms: 180000 };
    this.current = {
      device: { id: targetDevice },
      context: null,
      item,
      is_playing: true,
      shuffle_state: false,
      repeat_state: 'off',
      progress_ms: 0
    };
  }
  async playPlaylistAt(uri, offset, targetDevice) {
    this.restored.push({ uri, offset, targetDevice });
    this.current = {
      device: { id: targetDevice },
      context: { type: 'playlist', uri },
      item: tracks[offset],
      is_playing: true,
      shuffle_state: false,
      repeat_state: 'off',
      progress_ms: 0
    };
  }
}

function createCoordinator() {
  const spotify = new FakeSpotify();
  const store = new QueueStore(new MemoryStorage());
  const timers = { setInterval: () => 1, clearInterval: () => {} };
  const logger = { info() {}, warn() {}, error() {} };
  const coordinator = new PlaybackCoordinator({
    spotify, store, playlistUri, playlistId: 'playlist1', timers, logger
  });
  return { spotify, store, coordinator };
}

const request = (id, track, requester = 'viewer') => ({
  id,
  uri: track.uri,
  title: track.name,
  artists: ['Artist'],
  durationMs: track.duration_ms,
  requester,
  queuedAt: Date.now()
});

test('plays viewer requests FIFO ahead of the saved playlist continuation', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-1', { ...tracks[2], name: 'X' }));
  await coordinator.enqueue(request('request-2', { ...tracks[3], name: 'Y' }));

  assert.equal(store.get().active.id, 'request-1');
  assert.deepEqual(store.get().pending.map(item => item.id), ['request-2']);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri]);

  assert.equal(await coordinator.skip(), true);
  assert.equal(store.get().active.id, 'request-2');
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri, tracks[3].uri]);

  assert.equal(await coordinator.skip(), true);
  assert.equal(store.get().active, null);
  assert.equal(store.get().snapshot, null);
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, tracks[1].uri);
});

test('keeps the original next-track offset when Spotify advances before pending requests finish', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-1', { ...tracks[2], name: 'X' }));
  await coordinator.enqueue(request('request-2', { ...tracks[3], name: 'Y' }));
  coordinator.started = true;

  spotify.current = {
    device: { id: deviceId },
    context: { type: 'playlist', uri: playlistUri },
    item: tracks[1],
    is_playing: true,
    shuffle_state: false,
    repeat_state: 'off',
    progress_ms: 0
  };
  await coordinator.poll();

  assert.equal(store.get().active.id, 'request-2');
  assert.equal(store.get().snapshot.nextOffset, 1);
  assert.equal(spotify.restored.length, 0);
  assert.equal(spotify.played.at(-1).uri, tracks[3].uri);

  await coordinator.skip();
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
});

test('does not advance a manually paused request', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-1', { ...tracks[2], name: 'X' }));
  spotify.current.is_playing = false;
  spotify.current.progress_ms = 45000;
  coordinator.started = true;

  await coordinator.poll();

  assert.equal(store.get().active.id, 'request-1');
  assert.equal(store.get().mode, 'paused-request');
  assert.equal(spotify.restored.length, 0);
});

test('hands control back on an unexpected manual track change and preserves the request', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-1', { ...tracks[2], name: 'X' }));
  spotify.current = {
    device: { id: deviceId },
    context: null,
    item: { id: 'manual', uri: 'spotify:track:manual', duration_ms: 180000 },
    is_playing: true
  };
  coordinator.started = true;

  await coordinator.poll();

  assert.equal(store.get().mode, 'handoff');
  assert.equal(store.get().active, null);
  assert.deepEqual(store.get().pending.map(item => item.id), ['request-1']);
  assert.equal(spotify.restored.length, 0);
});

test('refuses to interrupt a playlist when a manual queue entry precedes its next track', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  spotify.getQueue = async () => [{ uri: 'spotify:track:manual' }, tracks[1]];
  await assert.rejects(
    coordinator.enqueue(request('request-1', { ...tracks[2], name: 'X' })),
    /does not match/
  );
  assert.equal(spotify.played.length, 0);
  assert.equal(store.get().active, null);
  assert.equal(store.get().pending[0].id, 'request-1');
});

test('hands off instead of retrying when Spotify play cannot be confirmed', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  spotify.playTrack = async () => {};
  await assert.rejects(
    coordinator.enqueue(request('uncertain-request', { ...tracks[2], name: 'X' })),
    /not confirmed/
  );
  assert.equal(store.get().mode, 'handoff');
  assert.equal(store.get().active, null);
  assert.equal(store.get().snapshot, null);
  assert.deepEqual(store.get().pending.map(item => item.id), ['uncertain-request']);
});


test('does not replay a request when an EventSub redemption is delivered twice', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  const duplicate = request('redemption-duplicate', { ...tracks[2], name: 'X' });

  assert.equal(await coordinator.enqueue(duplicate), true);
  assert.equal(await coordinator.enqueue(duplicate), false);

  assert.equal(store.get().active.id, 'redemption-duplicate');
  assert.equal(store.get().pending.length, 0);
  assert.equal(spotify.played.length, 1);
});


test('recovers an active request after reload when Spotify still plays that request', async () => {
  const storage = new MemoryStorage();
  const spotify = new FakeSpotify();
  const firstStore = new QueueStore(storage);
  const firstCoordinator = new PlaybackCoordinator({
    spotify, store: firstStore, playlistUri, playlistId: 'playlist1',
    timers: { setInterval: () => 1, clearInterval() {} },
    logger: { info() {}, warn() {}, error() {} }
  });
  const activeRequest = request('reload-active', { ...tracks[2], name: 'X' });
  await firstCoordinator.enqueue(activeRequest);
  const reloadedStore = new QueueStore(storage);
  const reloadedCoordinator = new PlaybackCoordinator({
    spotify, store: reloadedStore, playlistUri, playlistId: 'playlist1',
    timers: { setInterval: () => 2, clearInterval() {} },
    logger: { info() {}, warn() {}, error() {} }
  });

  await reloadedCoordinator.start();

  assert.equal(reloadedStore.get().active.id, 'reload-active');
  assert.equal(reloadedStore.get().mode, 'playing-request');
  assert.deepEqual(reloadedStore.get().pending, []);
  assert.equal(spotify.played.length, 1);
  reloadedCoordinator.stop();
});

test('recovers by advancing to the next viewer request if Spotify already resumed the saved playlist track', async () => {
  const storage = new MemoryStorage();
  const spotify = new FakeSpotify();
  const firstStore = new QueueStore(storage);
  const firstCoordinator = new PlaybackCoordinator({
    spotify, store: firstStore, playlistUri, playlistId: 'playlist1',
    timers: { setInterval: () => 1, clearInterval() {} },
    logger: { info() {}, warn() {}, error() {} }
  });
  await firstCoordinator.enqueue(request('reload-complete-x', { ...tracks[2], name: 'X' }));
  await firstCoordinator.enqueue(request('reload-pending-y', { ...tracks[3], name: 'Y' }));

  spotify.current = {
    device: { id: deviceId },
    context: { type: 'playlist', uri: playlistUri },
    item: tracks[1],
    is_playing: true,
    shuffle_state: false,
    repeat_state: 'off',
    progress_ms: 0
  };

  const reloadedStore = new QueueStore(storage);
  const reloadedCoordinator = new PlaybackCoordinator({
    spotify, store: reloadedStore, playlistUri, playlistId: 'playlist1',
    timers: { setInterval: () => 2, clearInterval() {} },
    logger: { info() {}, warn() {}, error() {} }
  });

  await reloadedCoordinator.start();

  assert.equal(reloadedStore.get().active.id, 'reload-pending-y');
  assert.equal(reloadedStore.get().snapshot.nextOffset, 1);
  assert.equal(spotify.current.item.uri, tracks[3].uri);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri, tracks[3].uri]);
  reloadedCoordinator.stop();
});

test('hands off an active request with no persisted playlist snapshot after reload', async () => {
  const storage = new MemoryStorage();
  const spotify = new FakeSpotify();
  const store = new QueueStore(storage);
  store.update(state => {
    state.active = { ...request('missing-snapshot', tracks[2]), lastProgressMs: 0, startedAt: Date.now() };
    state.mode = 'starting';
  });

  const reloadedStore = new QueueStore(storage);
  const coordinator = new PlaybackCoordinator({
    spotify, store: reloadedStore, playlistUri, playlistId: 'playlist1',
    timers: { setInterval: () => 1, clearInterval() {} },
    logger: { info() {}, warn() {}, error() {} }
  });

  await coordinator.start();

  assert.equal(reloadedStore.get().mode, 'handoff');
  assert.equal(reloadedStore.get().active, null);
  assert.deepEqual(reloadedStore.get().pending.map(item => item.id), ['missing-snapshot']);
  assert.equal(spotify.played.length, 0);
  assert.equal(spotify.restored.length, 0);
  coordinator.stop();
});

test('hands off without replay when reload finds an unrelated Spotify track or device', async () => {
  for (const changedDevice of [false, true]) {
    const storage = new MemoryStorage();
    const spotify = new FakeSpotify();
    const store = new QueueStore(storage);
    store.update(state => {
      state.active = { ...request('manual-change-' + changedDevice, tracks[2]), lastProgressMs: 0, startedAt: Date.now() };
      state.snapshot = {
        playlistUri,
        deviceId,
        currentTrackUri: tracks[0].uri,
        nextOffset: 1,
        nextTrackUri: tracks[1].uri,
        playlistLength: tracks.length,
        capturedAt: Date.now()
      };
      state.mode = 'playing-request';
    });
    spotify.current = {
      device: { id: changedDevice ? 'other-device' : deviceId },
      context: null,
      item: { uri: 'spotify:track:manually-selected', duration_ms: 180000 },
      is_playing: true
    };

    const reloadedStore = new QueueStore(storage);
    const coordinator = new PlaybackCoordinator({
      spotify, store: reloadedStore, playlistUri, playlistId: 'playlist1',
      timers: { setInterval: () => 1, clearInterval() {} },
      logger: { info() {}, warn() {}, error() {} }
    });

    await coordinator.start();

    assert.equal(reloadedStore.get().mode, 'handoff');
    assert.equal(reloadedStore.get().active, null);
    assert.equal(reloadedStore.get().pending.length, 1);
    assert.equal(spotify.played.length, 0);
    assert.equal(spotify.restored.length, 0);
    coordinator.stop();
  }
});
