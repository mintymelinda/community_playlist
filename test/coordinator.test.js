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
      shuffle_state: this.current.shuffle_state ?? false,
      repeat_state: this.current.repeat_state ?? 'off',
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
      shuffle_state: this.current.shuffle_state ?? false,
      repeat_state: this.current.repeat_state ?? 'off',
      progress_ms: 0
    };
  }
}

function createCoordinator(options = {}) {
  const { autoAdvanceToNextTrack = true, ...coordinatorOptions } = options;
  const spotify = new FakeSpotify();
  const store = new QueueStore(new MemoryStorage());
  const timers = { setInterval: () => 1, clearInterval: () => {} };
  const logger = { info() {}, warn() {}, error() {} };
  const coordinator = new PlaybackCoordinator({
    spotify, store, playlistUri, playlistId: 'playlist1', timers, logger, ...coordinatorOptions
  });
  // Most legacy coordinator tests exercise request playback after a natural
  // playlist boundary. Model that boundary explicitly rather than making
  // enqueue interrupt the currently playing track.
  const enqueue = coordinator.enqueue.bind(coordinator);
  coordinator.enqueue = async item => {
    const accepted = await enqueue(item);
    const state = store.get();
    if (autoAdvanceToNextTrack && state.mode === 'waiting-for-playlist' && state.snapshot?.nextTrackUri) {
      const nextTrack = tracks.find(track => track.uri === state.snapshot.nextTrackUri);
      if (nextTrack) {
        spotify.current = {
          device: { id: deviceId },
          context: { type: 'playlist', uri: playlistUri },
          item: nextTrack,
          is_playing: true,
          shuffle_state: spotify.current.shuffle_state ?? false,
          repeat_state: spotify.current.repeat_state ?? 'off',
          progress_ms: 100
        };
        coordinator.started = true;
        try {
          await coordinator.poll();
        } finally {
          coordinator.started = false;
        }
      }
    }
    return accepted;
  };
  return { spotify, store, coordinator };
}

const request = (id, track, requester = 'viewer') => ({
  id,
  uri: track.uri,
  title: track.name,
  artists: ['Artist'],
  durationMs: track.duration_ms,
  isrc: track.isrc || null,
  requester,
  queuedAt: Date.now()
});

test('waits for the current playlist track to finish before starting the request FIFO', async () => {
  const { spotify, store, coordinator } = createCoordinator({ autoAdvanceToNextTrack: false });
  const originalTrack = clone(spotify.current.item);

  await coordinator.enqueue(request('wait-for-natural-end', tracks[2]));
  await coordinator.enqueue(request('second-waiting-request', tracks[3]));

  assert.equal(store.get().mode, 'waiting-for-playlist');
  assert.equal(store.get().active, null);
  assert.deepEqual(store.get().pending.map(item => item.id), ['wait-for-natural-end', 'second-waiting-request']);
  assert.deepEqual(spotify.played, []);
  assert.equal(spotify.current.item.uri, originalTrack.uri);
  assert.equal(spotify.current.context.uri, playlistUri);

  // Spotify naturally advances to the saved next playlist item.
  spotify.current = {
    ...spotify.current,
    item: tracks[1],
    progress_ms: 100,
    is_playing: true
  };
  coordinator.started = true;
  await coordinator.poll();
  coordinator.started = false;

  assert.equal(store.get().mode, 'playing-request');
  assert.equal(store.get().active.id, 'wait-for-natural-end');
  assert.deepEqual(store.get().pending.map(item => item.id), ['second-waiting-request']);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri]);

  await coordinator.skip();
  assert.equal(store.get().active.id, 'second-waiting-request');
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri, tracks[3].uri]);
  await coordinator.skip();
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, tracks[1].uri);
});

test('waits for a duplicate current track URI to advance to its next playlist occurrence', async () => {
  const { spotify, store, coordinator } = createCoordinator({ autoAdvanceToNextTrack: false });
  spotify.getPlaylistItems = async () => [tracks[0], tracks[0], tracks[1], tracks[2]];
  spotify.getQueue = async () => [tracks[0], tracks[1], tracks[2]];

  await coordinator.enqueue(request('duplicate-boundary', tracks[3]));
  assert.equal(store.get().mode, 'waiting-for-playlist');
  assert.equal(store.get().snapshot.nextTrackUri, tracks[0].uri);
  assert.deepEqual(spotify.played, []);

  // The same URI is now the next occurrence, and its upcoming queue begins
  // with the track after that duplicate.
  spotify.current = { ...spotify.current, progress_ms: 100 };
  spotify.getQueue = async () => [tracks[1], tracks[2]];
  coordinator.started = true;
  await coordinator.poll();
  coordinator.started = false;

  assert.equal(store.get().mode, 'playing-request');
  assert.equal(store.get().active.id, 'duplicate-boundary');
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[3].uri]);
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


test('does not dispatch a pending request without an explicit completion or skip transition', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-x', tracks[2]));

  store.update(state => {
    state.pending.push(request('request-y', tracks[3]));
    state.active = null;
    // Simulate an inconsistent state where the active request was cleared
    // without recording a skip/completion transition.
  });

  await coordinator.pump();

  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri]);
  assert.equal(store.get().mode, 'playing-request');
  assert.equal(store.get().pending[0].id, 'request-y');
});

test('restores the playlist URI captured in the snapshot even if the coordinator default changes', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-x', tracks[2]));

  coordinator.playlistUri = 'spotify:playlist:challenge-run';
  assert.equal(await coordinator.skip(), true);

  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(store.get().snapshot, null);
});

test('restores the playlist after skipping a request that Spotify played through an ISRC relink', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  const requestedUri = 'spotify:track:requested-track-id';
  const playableUri = 'spotify:track:market-playable-track-id';
  const requestedIsrc = 'USRC17607839';
  const relinkedRequest = {
    id: 'relinked-request',
    uri: requestedUri,
    title: 'Relinked request',
    durationMs: 180000,
    isrc: requestedIsrc,
    requester: 'viewer',
    queuedAt: Date.now()
  };

  spotify.playTrack = async (uri, targetDevice) => {
    spotify.played.push({ uri, targetDevice });
    spotify.current = {
      device: { id: targetDevice },
      context: null,
      item: { uri: playableUri, name: 'Relinked request', duration_ms: 180000 },
      is_playing: true,
      progress_ms: 0
    };
  };
  spotify.getTrack = async uri => {
    assert.equal(uri, playableUri);
    return { uri: playableUri, isrc: requestedIsrc };
  };

  await coordinator.enqueue(relinkedRequest);

  assert.equal(store.get().active.id, relinkedRequest.id);
  assert.equal(store.get().active.lastPlaybackUri, playableUri);
  assert.equal(await coordinator.skip(), true);
  assert.equal(store.get().mode, 'idle');
  assert.equal(store.get().active, null);
  assert.equal(store.get().snapshot, null);
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, tracks[1].uri);
});

test('does not confuse a stale playlist-context read with natural completion of the active viewer request', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-x', { ...tracks[2], name: 'X' }));
  await coordinator.enqueue(request('request-y', { ...tracks[3], name: 'Y' }));
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

  assert.equal(store.get().active.id, 'request-x');
  assert.deepEqual(store.get().pending.map(item => item.id), ['request-y']);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri]);
  assert.equal(spotify.restored.length, 0);

  store.update(state => { state.active.lastProgressMs = tracks[2].duration_ms - 2000; });
  await coordinator.poll();

  assert.equal(store.get().active.id, 'request-y');
  assert.deepEqual(store.get().pending, []);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri, tracks[3].uri]);
});

test('keeps a viewer request distinct when its URI matches the saved playlist continuation', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-same-as-next', { ...tracks[1], name: 'Playlist-next recording' }));
  await coordinator.enqueue(request('request-after', { ...tracks[3], name: 'Y' }));
  coordinator.started = true;

  // Spotify may retain playlist context even while the same recording is
  // playing as a direct viewer request. The active request identity wins
  // until its observed progress establishes natural completion.
  spotify.current.context = { type: 'playlist', uri: playlistUri };
  spotify.current.progress_ms = 1000;
  await coordinator.poll();

  assert.equal(store.get().active.id, 'request-same-as-next');
  assert.deepEqual(store.get().pending.map(item => item.id), ['request-after']);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[1].uri]);

  store.update(state => { state.active.lastProgressMs = tracks[1].duration_ms - 2000; });
  spotify.current.progress_ms = 0;
  await coordinator.poll();

  assert.equal(store.get().active.id, 'request-after');
  assert.deepEqual(store.get().pending, []);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[1].uri, tracks[3].uri]);
});

test('serializes a second redemption behind Spotify confirmation of the active request', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  let releaseConfirmation;
  let playStarted;
  const started = new Promise(resolve => { playStarted = resolve; });
  const confirmation = new Promise(resolve => { releaseConfirmation = resolve; });
  const originalGetPlaybackState = spotify.getPlaybackState.bind(spotify);
  let waitingForConfirmation = false;

  spotify.playTrack = async (uri, targetDevice) => {
    spotify.played.push({ uri, targetDevice });
    spotify.current = {
      device: { id: targetDevice },
      context: null,
      item: tracks.find(track => track.uri === uri),
      is_playing: true,
      progress_ms: 0
    };
    waitingForConfirmation = true;
    playStarted();
  };
  spotify.getPlaybackState = async () => {
    if (waitingForConfirmation) return confirmation;
    return originalGetPlaybackState();
  };

  const first = coordinator.enqueue(request('request-mozart', tracks[2]));
  await started;
  const second = coordinator.enqueue(request('request-sex-machina', tracks[3]));

  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri]);
  assert.equal(store.get().active.id, 'request-mozart');
  assert.deepEqual(store.get().pending, [], 'the second redemption must not mutate the queue during first-track confirmation');

  releaseConfirmation({
    device: { id: deviceId },
    context: null,
    item: tracks[2],
    is_playing: true,
    progress_ms: 100
  });
  await Promise.all([first, second]);

  assert.equal(store.get().active.id, 'request-mozart');
  assert.deepEqual(store.get().pending.map(item => item.id), ['request-sex-machina']);
  assert.deepEqual(spotify.played.map(item => item.uri), [tracks[2].uri]);
});

test('captures the playlist continuation when the current Spotify URI is not in the playlist response', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  spotify.current.item = { uri: 'spotify:track:spotify-relinked-current', duration_ms: 180000 };
  spotify.getQueue = async () => tracks.slice(1);

  await coordinator.enqueue(request('relinked-current', { ...tracks[3], name: 'X' }));

  assert.equal(store.get().snapshot.currentTrackUri, 'spotify:track:spotify-relinked-current');
  assert.equal(store.get().snapshot.nextOffset, 1);
  assert.equal(store.get().snapshot.nextTrackUri, tracks[1].uri);
  assert.equal(spotify.played[0].uri, tracks[3].uri);
});

test('captures the next playable playlist item after unavailable placeholders', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  spotify.getPlaylistItems = async () => [tracks[0], null, tracks[1], tracks[2]];
  spotify.getQueue = async () => [tracks[1], tracks[2]];

  await coordinator.enqueue(request('after-unavailable', { ...tracks[3], name: 'X' }));

  assert.equal(store.get().snapshot.nextOffset, 2);
  assert.equal(store.get().snapshot.nextTrackUri, tracks[1].uri);
  assert.equal(spotify.played[0].uri, tracks[3].uri);
});

test('preserves the next shuffled playlist track and shuffle setting across requests', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  spotify.current.shuffle_state = true;
  spotify.getQueue = async () => [tracks[3], tracks[1], tracks[2]];

  await coordinator.enqueue(request('shuffled-request', { ...tracks[2], name: 'X' }));

  assert.equal(store.get().snapshot.nextOffset, 3);
  assert.equal(store.get().snapshot.nextTrackUri, tracks[3].uri);
  assert.equal(spotify.current.shuffle_state, true);

  assert.equal(await coordinator.skip(), true);
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 3, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, tracks[3].uri);
  assert.equal(spotify.current.shuffle_state, true);
});

test('still refuses repeat mode even when shuffle-aware position resolution is available', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  spotify.current.shuffle_state = true;
  spotify.current.repeat_state = 'context';

  await assert.rejects(
    coordinator.enqueue(request('repeat-enabled-request', { ...tracks[2], name: 'X' })),
    /Turn Spotify repeat off/
  );
  assert.equal(spotify.played.length, 0);
  assert.equal(store.get().active, null);
  assert.equal(store.get().pending[0].id, 'repeat-enabled-request');
});

test('keeps the original next-track offset when Spotify advances before pending requests finish', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  await coordinator.enqueue(request('request-1', { ...tracks[2], name: 'X' }));
  await coordinator.enqueue(request('request-2', { ...tracks[3], name: 'Y' }));
  store.update(state => { state.active.lastProgressMs = tracks[2].duration_ms - 2000; });
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

test('waits for delayed Spotify playback-state updates after play is accepted', async () => {
  const { spotify, coordinator } = createCoordinator({
    playbackConfirmationTimeoutMs: 2000,
    playbackConfirmationPollMs: 100
  });
  const previous = clone(spotify.current);
  let reads = 0;
  spotify.getPlaybackState = async () => {
    reads += 1;
    if (reads <= 8) return previous;
    return {
      ...previous,
      item: tracks[2],
      is_playing: true,
      progress_ms: 0
    };
  };

  const confirmed = await coordinator.waitForTrack(tracks[2].uri, deviceId);

  assert.equal(confirmed.item.uri, tracks[2].uri);
  assert.ok(reads > 6, 'confirmation should continue beyond the old six-read limit');
});


test('does not confirm a matching Spotify track until playback is actually running', async () => {
  const { coordinator } = createCoordinator({
    playbackConfirmationTimeoutMs: 2000,
    playbackConfirmationPollMs: 100
  });
  const paused = {
    device: { id: deviceId },
    context: null,
    item: tracks[2],
    is_playing: false,
    progress_ms: 0
  };
  let reads = 0;
  coordinator.spotify.getPlaybackState = async () => {
    reads += 1;
    return reads <= 3 ? paused : { ...paused, is_playing: true, progress_ms: 100 };
  };

  const confirmed = await coordinator.waitForTrack(tracks[2].uri, deviceId);

  assert.equal(confirmed.is_playing, true);
  assert.ok(reads > 3, 'confirmation must wait until Spotify reports active playback');
});

test('confirms Spotify-relinked playback using the original linked_from URI', async () => {
  const { spotify, coordinator } = createCoordinator();
  const requestedUri = tracks[2].uri;
  spotify.current = {
    ...spotify.current,
    item: {
      ...tracks[3],
      linked_from: {
        id: tracks[2].id,
        uri: requestedUri
      }
    }
  };

  const confirmed = await coordinator.waitForTrack(requestedUri, deviceId);

  assert.equal(confirmed.item.uri, tracks[3].uri);
  assert.equal(confirmed.item.linked_from.uri, requestedUri);
});

test('confirms a relinked Spotify playback URI using matching ISRC when linked_from is absent', async () => {
  const { coordinator } = createCoordinator();
  const requestedIsrc = 'USRC17607839';
  const requestedUri = 'spotify:track:requested-track-id';
  const playableUri = 'spotify:track:market-playable-track-id';
  coordinator.spotify.getPlaybackState = async () => ({
    device: { id: deviceId },
    context: null,
    item: {
      uri: playableUri,
      name: 'SEX MACHINA'
    },
    is_playing: true,
    progress_ms: 250
  });
  let metadataLookups = 0;
  coordinator.spotify.getTrack = async uri => {
    metadataLookups += 1;
    assert.equal(uri, playableUri);
    return { uri: playableUri, isrc: requestedIsrc };
  };

  const confirmed = await coordinator.waitForTrack(requestedUri, deviceId, {
    expectedIsrc: requestedIsrc
  });

  assert.equal(confirmed.item.uri, playableUri);
  assert.equal(metadataLookups, 1, 'playable track metadata should be resolved once and cached');
});

test('keeps waiting through transient playback-state API errors', async () => {
  const { coordinator } = createCoordinator({
    playbackConfirmationTimeoutMs: 2000,
    playbackConfirmationPollMs: 100
  });
  const previous = clone({
    device: { id: deviceId },
    context: { type: 'playlist', uri: playlistUri },
    item: tracks[0],
    is_playing: true,
    shuffle_state: false,
    repeat_state: 'off',
    progress_ms: 12000
  });
  let reads = 0;
  coordinator.spotify.getPlaybackState = async () => {
    reads += 1;
    if (reads <= 2) throw new Error('temporary Spotify player-state outage');
    if (reads <= 5) return null;
    return { ...previous, item: tracks[2], is_playing: true, progress_ms: 0 };
  };

  const confirmed = await coordinator.waitForTrack(tracks[2].uri, deviceId);

  assert.equal(confirmed.item.uri, tracks[2].uri);
  assert.ok(reads > 5);
});

test('hands off instead of retrying when Spotify play cannot be confirmed', async () => {
  const { spotify, store, coordinator } = createCoordinator({
    playbackConfirmationTimeoutMs: 1000,
    playbackConfirmationPollMs: 100
  });
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
  spotify.current = {
    device: { id: deviceId }, context: { type: 'playlist', uri: playlistUri },
    item: tracks[1], is_playing: true, shuffle_state: false, repeat_state: 'off', progress_ms: 100
  };
  firstCoordinator.started = true;
  await firstCoordinator.poll();
  firstCoordinator.started = false;
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
    progress_ms: 100
  };
  firstCoordinator.started = true;
  await firstCoordinator.poll();
  firstCoordinator.started = false;
  firstStore.update(state => { state.active.lastProgressMs = tracks[2].duration_ms - 2000; });

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

test('restores a playlist track when Spotify reports its market-relinked playable URI', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  const expectedUri = tracks[1].uri;
  const playableUri = 'spotify:track:market-relinked-playlist-track';
  const isrc = 'USRC17607839';

  spotify.getPlaylistItems = async () => [
    tracks[0],
    tracks[1],
    tracks[2],
    tracks[3]
  ];
  spotify.getQueue = async () => [
    tracks[1],
    tracks[2],
    tracks[3]
  ];
  spotify.playPlaylistAt = async (uri, offset, targetDevice) => {
    spotify.restored.push({ uri, offset, targetDevice });
    spotify.current = {
      device: { id: targetDevice },
      context: { type: 'playlist', uri },
      item: { uri: playableUri, name: 'Market relinked playlist track', duration_ms: 180000 },
      is_playing: true,
      progress_ms: 0
    };
  };
  spotify.getTrack = async uri => {
    assert.ok(uri === expectedUri || uri === playableUri);
    return { uri, isrc };
  };

  await coordinator.enqueue(request('request-before-playlist-restore', tracks[2]));

  assert.equal(store.get().snapshot.nextTrackUri, expectedUri);
  assert.equal(store.get().snapshot.nextTrackIsrc, isrc);
  assert.equal(await coordinator.skip(), true);
  assert.equal(store.get().mode, 'idle');
  assert.equal(store.get().snapshot, null);
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, playableUri);
});


test('confirms playlist restoration by its following queue item when the restored track URI is market-relinked and metadata is unavailable', async () => {
  const { spotify, store, coordinator } = createCoordinator();
  const expectedIsrc = 'ITA870700318';
  const playableUri = 'spotify:track:market-playable-restored-track';

  spotify.getPlaylistItems = async () => [
    tracks[0],
    { ...tracks[1], isrc: expectedIsrc },
    tracks[2],
    tracks[3]
  ];
  spotify.getTrack = async uri => {
    if (uri === playableUri) {
      const error = new Error('Spotify track metadata is unavailable in this market.');
      error.status = 404;
      throw error;
    }
    return { ...tracks.find(track => track.uri === uri), isrc: expectedIsrc };
  };
  spotify.playPlaylistAt = async (uri, offset, targetDevice) => {
    spotify.restored.push({ uri, offset, targetDevice });
    spotify.current = {
      device: { id: targetDevice },
      context: { type: 'playlist', uri },
      item: { uri: playableUri, name: 'Market-playable restored item', duration_ms: 180000 },
      is_playing: true,
      progress_ms: 12000
    };
  };
  spotify.getQueue = async () => spotify.restored.length
    ? [tracks[2], tracks[3]]
    : tracks.slice(1);

  await coordinator.enqueue(request('request-before-relinked-restore', tracks[3]));

  assert.equal(store.get().snapshot.nextTrackUri, tracks[1].uri);
  assert.equal(store.get().snapshot.nextTrackIsrc, expectedIsrc);
  assert.equal(store.get().snapshot.followingTrackUri, tracks[2].uri);

  assert.equal(await coordinator.skip(), true);
  assert.equal(store.get().mode, 'idle');
  assert.equal(store.get().snapshot, null);
  assert.equal(store.get().active, null);
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, playableUri);
});


test('matches the active playlist by Spotify ID when its context is reported as a web URL', async () => {
  const { spotify, store, coordinator } = createCoordinator({ autoAdvanceToNextTrack: false });
  const playlistUrl = 'https://open.spotify.com/playlist/playlist1?si=live-session';
  spotify.current.context.uri = playlistUrl;

  await coordinator.enqueue(request('playlist-id-context', tracks[2]));

  assert.equal(store.get().mode, 'waiting-for-playlist');
  assert.equal(store.get().snapshot.playlistUri, playlistUri);
  assert.equal(store.get().snapshot.nextTrackUri, tracks[1].uri);

  spotify.current = {
    ...spotify.current,
    context: { type: 'playlist', uri: playlistUrl },
    item: tracks[1],
    is_playing: true,
    progress_ms: 100
  };
  coordinator.started = true;
  try {
    await coordinator.poll();
  } finally {
    coordinator.started = false;
  }

  assert.equal(store.get().active.id, 'playlist-id-context');
  assert.equal(store.get().mode, 'playing-request');
  assert.equal(spotify.played[0].uri, tracks[2].uri);
});


test('restores any playing track in the same playlist when shuffle selects a different continuation', async () => {
  const { spotify, store, coordinator } = createCoordinator({
    playbackConfirmationTimeoutMs: 1000,
    playbackConfirmationPollMs: 100
  });
  spotify.current.shuffle_state = true;
  spotify.playPlaylistAt = async (uri, offset, targetDevice) => {
    spotify.restored.push({ uri, offset, targetDevice });
    // Spotify shuffle is free to resume a different item from the same playlist.
    spotify.current = {
      device: { id: targetDevice },
      context: { type: 'playlist', uri },
      item: tracks[3],
      is_playing: true,
      shuffle_state: true,
      repeat_state: 'off',
      progress_ms: 250
    };
  };

  await coordinator.enqueue(request('shuffle-restore', tracks[2]));
  assert.equal(store.get().snapshot.shuffle, true, 'the snapshot must retain the shuffle state captured before requests');
  assert.equal(store.get().active.id, 'shuffle-restore');

  assert.equal(await coordinator.skip(), true);
  assert.deepEqual(spotify.restored, [{ uri: playlistUri, offset: 1, targetDevice: deviceId }]);
  assert.equal(spotify.current.item.uri, tracks[3].uri);
  assert.equal(spotify.current.context.uri, playlistUri);
  assert.equal(spotify.current.is_playing, true);
  assert.equal(store.get().mode, 'idle');
  assert.equal(store.get().snapshot, null);
});
