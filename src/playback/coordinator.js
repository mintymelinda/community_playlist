import { SerialExecutor } from '../lib/serial.js';
import { resolveNextPlaylistOffset } from './position.js';

function trackUri(state) {
  // Spotify can play a market-available replacement for the requested track.
  // In that case item.uri is the playable replacement and linked_from.uri is
  // the original URI supplied by the request/playlist.
  return state?.item?.linked_from?.uri || state?.item?.uri || null;
}

export class PlaybackCoordinator {
  constructor({
    spotify,
    store,
    playlistUri,
    playlistId,
    deviceId = '',
    pollIntervalMs = 2000,
    playbackConfirmationTimeoutMs = 20000,
    playbackConfirmationPollMs = 400,
    logger = console,
    timers = globalThis
  }) {
    this.spotify = spotify;
    this.store = store;
    this.playlistUri = playlistUri;
    this.playlistId = playlistId;
    this.configuredDeviceId = deviceId;
    this.pollIntervalMs = pollIntervalMs;
    this.playbackConfirmationTimeoutMs = Math.max(1000, Number(playbackConfirmationTimeoutMs) || 20000);
    this.playbackConfirmationPollMs = Math.max(100, Number(playbackConfirmationPollMs) || 400);
    this.logger = logger;
    this.timers = timers;
    this.serial = new SerialExecutor();
    this.instanceId = globalThis.crypto?.randomUUID?.() || ('controller-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    this.operationSequence = 0;
    this.pollTimer = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.serial.run(() => this.reconcile());
    this.pollTimer = this.timers.setInterval(() => {
      this.serial.run(() => this.poll()).catch(error => this.logError('Playback poll failed.', error));
    }, this.pollIntervalMs);
  }

  stop() {
    this.started = false;
    if (this.pollTimer !== null) this.timers.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  logError(message, error) {
    this.logger.error('[community-playlist] ' + message, error);
    try {
      this.store.update(state => { state.lastError = error.message; });
    } catch (storageError) {
      this.logger.error('[community-playlist] Could not persist playback error.', storageError);
    }
  }

  async enqueue(request) {
    const operationId = ++this.operationSequence;
    this.logger.info('[community-playlist] Queue enqueue requested.', {
      controllerInstance: this.instanceId,
      operationId,
      requestId: request.id,
      uri: request.uri,
      state: this.queueDiagnosticState()
    });
    if (this.store.containsRequest(request.id)) {
      this.logger.info('[community-playlist] Duplicate queue request ignored.', {
        controllerInstance: this.instanceId, operationId, requestId: request.id
      });
      return false;
    }
    const accepted = this.store.enqueue(request);
    if (!accepted) throw new Error('The request queue is full. The redemption was not queued.');
    await this.serial.run(() => this.pump());
    this.logger.info('[community-playlist] Queue enqueue completed.', {
      controllerInstance: this.instanceId, operationId, requestId: request.id,
      state: this.queueDiagnosticState()
    });
    return true;
  }

  queueDiagnosticState() {
    const state = this.store.get();
    return {
      activeRequestId: state.active?.id || null,
      pendingRequestIds: state.pending.map(item => item.id),
      mode: state.mode
    };
  }

  async skip() {
    return this.serial.run(async () => {
      const state = this.store.get();
      if (!state.active) return false;
      const current = await this.spotify.getPlaybackState();
      if (!current || current.device?.id !== state.snapshot?.deviceId || trackUri(current) !== state.active.uri) {
        this.handoff('Playback changed before the skip command could be applied.');
        return false;
      }

      this.store.update(next => {
        next.lastRequestUri = next.active.uri;
        next.active = null;
        next.mode = 'skipping';
      });
      await this.pump();
      return true;
    });
  }

  async resume() {
    return this.serial.run(async () => {
      const state = this.store.get();
      if (state.mode !== 'handoff') return false;
      const current = await this.spotify.getPlaybackState();
      if (!current || current.context?.uri !== this.playlistUri || !current.is_playing) {
        throw new Error('Resume requires the configured playlist to be actively playing again.');
      }
      this.store.update(next => {
        next.mode = 'idle';
        next.active = null;
        next.snapshot = null;
      });
      await this.pump();
      return true;
    });
  }

  async captureSnapshot() {
    const playback = await this.spotify.getPlaybackState();
    if (!playback || !playback.is_playing) {
      throw new Error('Start the configured playlist on Spotify before accepting requests.');
    }
    if (!playback.device?.id) throw new Error('Spotify did not report an active playback device.');
    const deviceId = this.configuredDeviceId || playback.device.id;
    if (playback.device.id !== deviceId) {
      throw new Error('The configured Spotify device is not the active playback device.');
    }
    if (playback.context?.type !== 'playlist' || playback.context?.uri !== this.playlistUri) {
      throw new Error('The configured playlist must be the active Spotify playback context.');
    }
    if (playback.repeat_state !== 'off') {
      throw new Error('Turn Spotify repeat off before using viewer requests.');
    }
    const currentUri = trackUri(playback);
    if (!currentUri) throw new Error('Spotify did not report the current playlist track.');

    const [playlistTracks, upcoming] = await Promise.all([
      this.spotify.getPlaylistItems(this.playlistId),
      this.spotify.getQueue()
    ]);
    const position = resolveNextPlaylistOffset({
      playlistTracks,
      currentTrackUri: currentUri,
      upcomingTracks: upcoming,
      shuffle: playback.shuffle_state === true
    });

    return {
      playlistUri: this.playlistUri,
      deviceId,
      currentTrackUri: currentUri,
      nextOffset: position.nextOffset,
      nextTrackUri: position.nextTrackUri,
      playlistLength: playlistTracks.length,
      capturedAt: Date.now()
    };
  }

  async pump() {
    const state = this.store.get();
    if (state.mode === 'handoff' || state.active) return;

    if (!state.pending.length) {
      if (state.snapshot) await this.restorePlaylist();
      else this.store.update(next => { next.mode = 'idle'; });
      return;
    }

    let snapshot = state.snapshot;
    if (!snapshot) {
      snapshot = await this.captureSnapshot();
      this.store.update(next => {
        next.snapshot = snapshot;
        next.mode = 'starting';
      });
    }

    const request = this.store.get().pending[0];
    this.store.update(next => {
      next.pending.shift();
      next.active = { ...request, lastProgressMs: 0, startedAt: Date.now() };
      next.mode = 'starting';
      next.lastError = null;
    });

    const playAttemptId = this.instanceId + ':' + (++this.operationSequence);
    this.logger.info('[community-playlist] Issuing Spotify play command.', {
      controllerInstance: this.instanceId,
      playAttemptId,
      requestId: request.id,
      uri: request.uri,
      deviceId: snapshot.deviceId,
      state: this.queueDiagnosticState()
    });
    try {
      await this.spotify.playTrack(request.uri, snapshot.deviceId);
      this.logger.info('[community-playlist] Spotify accepted play command; beginning playback confirmation.', {
        controllerInstance: this.instanceId, playAttemptId, requestId: request.id
      });
      const confirmed = await this.waitForTrack(request.uri, snapshot.deviceId, { requestId: request.id, playAttemptId });
      if (!confirmed) throw new Error('Spotify accepted the play command but the requested track was not confirmed.');
      this.store.update(next => {
        if (next.active?.id === request.id) {
          next.active.lastProgressMs = confirmed.progress_ms || 0;
          next.active.durationMs = confirmed.item?.duration_ms || request.durationMs || 0;
          next.mode = 'playing-request';
        }
      });
      this.logger.info('[community-playlist] Playback confirmed.', {
        controllerInstance: this.instanceId, playAttemptId, requestId: request.id,
        uri: request.uri, observedUri: trackUri(confirmed), deviceId: confirmed.device?.id,
        item: confirmed.item?.name || null
      });
      this.logger.info('[community-playlist] Playing request: ' + request.title + ' (' + request.requester + ').');
    } catch (error) {
      this.handoff('Could not confirm whether Spotify started the request. The request was preserved for manual recovery. ' + error.message);
      throw error;
    }
  }

  async waitForTrack(uri, deviceId, context = {}) {
    const { requestId = null, playAttemptId = null } = context;
    this.logger.info('[community-playlist] Playback confirmation started.', {
      controllerInstance: this.instanceId, playAttemptId, requestId, expectedUri: uri, deviceId
    });
    const deadline = Date.now() + this.playbackConfirmationTimeoutMs;
    let lastState = null;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const state = await this.spotify.getPlaybackState();
        if (state?.device?.id === deviceId && trackUri(state) === uri && state.is_playing === true) {
          this.logger.info('[community-playlist] Playback confirmation matched.', {
            controllerInstance: this.instanceId, playAttemptId, requestId,
            expectedUri: uri, observedUri: trackUri(state), deviceId,
            progressMs: state.progress_ms ?? null
          });
          return state;
        }
        lastState = state || null;
      } catch (error) {
        // Spotify can briefly return an unavailable/stale player state after
        // accepting a play command. Keep polling until the bounded deadline.
        lastError = error;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise(resolve => setTimeout(
          resolve,
          Math.min(this.playbackConfirmationPollMs, remainingMs)
        ));
      }
    }

    const observedUri = trackUri(lastState) || 'none';
    const playableUri = lastState?.item?.uri || 'none';
    const observedDevice = lastState?.device?.id || 'none';
    const diagnostic = 'Expected track ' + uri + ' on device ' + deviceId +
      '; last observed track ' + observedUri + ' (playable URI ' + playableUri +
      ') on device ' + observedDevice +
      '; is_playing=' + String(lastState?.is_playing ?? 'unknown') +
      '; progress_ms=' + String(lastState?.progress_ms ?? 'unknown') +
      '; context=' + String(lastState?.context?.uri || 'none') +
      '; item=' + String(lastState?.item?.name || 'unknown') +
      '; restriction=' + String(lastState?.item?.restrictions?.reason || 'none') + '.' +
      (lastError ? ' Last playback-state API error: ' + lastError.message : '');
    this.logger.warn('[community-playlist] Spotify playback confirmation timed out. ' + diagnostic, {
      controllerInstance: this.instanceId, playAttemptId, requestId,
      expectedUri: uri, deviceId, queueState: this.queueDiagnosticState()
    });
    return null;
  }

  async poll() {
    if (!this.started) return;
    const currentState = this.store.get();
    if (!currentState.active) {
      if (currentState.mode !== 'handoff' && currentState.pending.length) await this.pump();
      return;
    }

    const playback = await this.spotify.getPlaybackState();
    const state = this.store.get();
    const active = state.active;
    const snapshot = state.snapshot;
    if (!active || !snapshot) return;

    if (!playback) {
      const duration = Number(active.durationMs) || 0;
      if (duration > 0 && active.lastProgressMs >= duration - 2000) {
        await this.completeActive();
      }
      return;
    }

    if (playback.device?.id !== snapshot.deviceId) {
      this.handoff('Spotify changed playback devices; the controller stopped controlling playback.');
      return;
    }

    const currentUri = trackUri(playback);
    const returnedToPlaylist = snapshot.nextTrackUri &&
      currentUri === snapshot.nextTrackUri &&
      playback.context?.uri === this.playlistUri;

    if (returnedToPlaylist) {
      const hasPending = state.pending.length > 0;
      this.logger.info('[community-playlist] Spotify returned to the expected playlist continuation.');
      this.store.update(next => {
        next.lastRequestUri = next.active.uri;
        next.active = null;
        if (!hasPending) next.snapshot = null;
        next.mode = 'idle';
      });
      await this.pump();
      return;
    }

    if (currentUri === active.uri) {
      const progress = Number(playback.progress_ms) || 0;
      const duration = Number(playback.item?.duration_ms) || active.durationMs || 0;
      this.store.update(next => {
        if (!next.active || next.active.id !== active.id) return;
        next.active.lastProgressMs = Math.max(next.active.lastProgressMs || 0, progress);
        next.active.durationMs = duration;
        next.mode = playback.is_playing ? 'playing-request' : 'paused-request';
      });
      if (!playback.is_playing && duration > 0 && progress >= duration - 2000) {
        await this.completeActive();
      }
      return;
    }

    this.handoff('Spotify playback changed outside the request controller. Remaining requests were preserved.');
  }

  async completeActive() {
    this.store.update(state => {
      state.lastRequestUri = state.active?.uri || state.lastRequestUri;
      state.active = null;
      state.mode = 'request-complete';
    });
    await this.pump();
  }

  async restorePlaylist() {
    const state = this.store.get();
    const snapshot = state.snapshot;
    if (!snapshot) return;
    if (snapshot.nextOffset >= snapshot.playlistLength) {
      this.store.update(next => {
        next.snapshot = null;
        next.mode = 'idle';
      });
      return;
    }

    const playback = await this.spotify.getPlaybackState();
    if (playback && playback.device?.id !== snapshot.deviceId) {
      this.handoff('Spotify changed playback devices before playlist restoration.');
      return;
    }
    const currentUri = trackUri(playback);
    const allowedRequestUri = state.active?.uri || state.lastRequestUri;
    if (currentUri && currentUri !== allowedRequestUri && currentUri !== snapshot.nextTrackUri) {
      this.handoff('Playback changed manually before playlist restoration; leaving it untouched.');
      return;
    }
    if (currentUri === snapshot.nextTrackUri && playback?.context?.uri === this.playlistUri) {
      this.store.update(next => {
        next.snapshot = null;
        next.mode = 'idle';
      });
      return;
    }

    await this.spotify.playPlaylistAt(this.playlistUri, snapshot.nextOffset, snapshot.deviceId);
    const restored = await this.waitForTrack(snapshot.nextTrackUri, snapshot.deviceId);
    if (!restored) throw new Error('Spotify did not confirm the expected playlist continuation.');
    this.store.update(next => {
      next.snapshot = null;
      next.mode = 'idle';
      next.lastError = null;
    });
    this.logger.info('[community-playlist] Restored playlist at offset ' + snapshot.nextOffset + '.');
  }

  handoff(reason) {
    this.store.update(state => {
      if (state.active) state.pending.unshift(state.active);
      state.active = null;
      state.snapshot = null;
      state.mode = 'handoff';
      state.lastError = reason;
    });
    this.logger.warn('[community-playlist] ' + reason);
  }

  async reconcile() {
    const state = this.store.get();
    if (!state.active) {
      if (state.snapshot) {
        this.store.update(next => {
          next.snapshot = null;
          next.mode = 'handoff';
          next.lastError = 'A previous session left a playlist snapshot without an active request. Resume the playlist and retry.';
        });
        return;
      }
      if (state.pending.length) {
        this.store.update(next => { next.mode = 'waiting-for-playlist'; });
        return;
      }
      return;
    }

    if (!state.snapshot) {
      this.store.update(next => {
        next.pending.unshift(next.active);
        next.active = null;
        next.mode = 'handoff';
        next.lastError = 'Recovered an incomplete request without its playlist snapshot. Resume manually before retrying.';
      });
      return;
    }

    const playback = await this.spotify.getPlaybackState();
    if (playback?.device?.id === state.snapshot.deviceId && trackUri(playback) === state.active.uri) {
      this.store.update(next => {
        next.active.lastProgressMs = Number(playback.progress_ms) || 0;
        next.active.durationMs = Number(playback.item?.duration_ms) || next.active.durationMs || 0;
        next.mode = playback.is_playing ? 'playing-request' : 'paused-request';
      });
      return;
    }

    if (playback?.device?.id === state.snapshot.deviceId &&
        trackUri(playback) === state.snapshot.nextTrackUri &&
        playback.context?.uri === this.playlistUri) {
      const hasPending = state.pending.length > 0;
      this.store.update(next => {
        next.lastRequestUri = next.active.uri;
        next.active = null;
        if (!hasPending) next.snapshot = null;
        next.mode = 'idle';
      });
      await this.pump();
      return;
    }

    this.handoff('The previous browser session could not confirm its active request. Requests were preserved for manual recovery.');
  }

  status() {
    const state = this.store.get();
    return {
      mode: state.mode,
      active: state.active ? { title: state.active.title, requester: state.active.requester } : null,
      pending: state.pending.length,
      lastError: state.lastError
    };
  }
}
