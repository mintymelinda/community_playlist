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
    this.trackMetadataCache = new Map();
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

    // Queue mutation belongs inside the same executor as playback transitions.
    // Otherwise a redemption can change persisted queue state while an earlier
    // play command is still awaiting Spotify confirmation.
    return this.serial.run(async () => {
      if (this.store.containsRequest(request.id)) {
        this.logger.info('[community-playlist] Duplicate queue request ignored.', {
          controllerInstance: this.instanceId, operationId, requestId: request.id
        });
        return false;
      }
      const accepted = this.store.enqueue(request);
      if (!accepted) throw new Error('The request queue is full. The redemption was not queued.');
      await this.pump();
      this.logger.info('[community-playlist] Queue enqueue completed.', {
        controllerInstance: this.instanceId, operationId, requestId: request.id,
        state: this.queueDiagnosticState()
      });
      return true;
    });
  }

  queueDiagnosticState() {
    const state = this.store.get();
    return {
      activeRequestId: state.active?.id || null,
      pendingRequestIds: state.pending.map(item => item.id),
      mode: state.mode
    };
  }

  hasNaturallyCompleted(active) {
    const durationMs = Number(active?.durationMs) || 0;
    const progressMs = Number(active?.lastProgressMs) || 0;
    if (!durationMs) return false;

    // A playlist-context player-state response is not enough to prove that a
    // viewer request ended: Spotify can briefly return a stale playlist item
    // after accepting a direct track play. Require progress observed on the
    // active request to be close to its duration before treating the saved
    // playlist continuation as a natural completion.
    const completionWindowMs = Math.max(5000, this.pollIntervalMs * 2);
    return progressMs >= durationMs - completionWindowMs;
  }

  async getTrackMetadata(uri) {
    if (!this.trackMetadataCache.has(uri)) {
      const lookup = Promise.resolve()
        .then(() => this.spotify.getTrack(uri))
        .catch(error => {
          this.logger.warn('[community-playlist] Could not resolve Spotify playable-track metadata.', {
            playableUri: uri, error: error.message
          });
          throw error;
        });
      this.trackMetadataCache.set(uri, lookup);
    }
    return this.trackMetadataCache.get(uri);
  }

  async trackMatchesRequest(state, request) {
    if (!state?.item || !request) return false;
    if (trackUri(state) === request.uri) return true;

    const expectedIsrc = String(request.isrc || '').trim().toUpperCase();
    if (!expectedIsrc) return false;

    // The Spotify player-state endpoint omits external_ids. Resolve the
    // playable URI through GET /tracks/{id}, and cache the result so polling
    // does not repeatedly hit the metadata endpoint.
    const playableUri = state.item.uri;
    if (!playableUri) return false;
    let playableTrack = null;
    try {
      playableTrack = await this.getTrackMetadata(playableUri);
    } catch {
      return false;
    }
    const observedIsrc = String(playableTrack?.isrc || '').trim().toUpperCase();
    return Boolean(observedIsrc && observedIsrc === expectedIsrc);
  }

  async skip() {
    return this.serial.run(async () => {
      const state = this.store.get();
      if (!state.active) return false;
      const current = await this.spotify.getPlaybackState();
      if (!current || current.device?.id !== state.snapshot?.deviceId || !(await this.trackMatchesRequest(current, state.active))) {
        this.handoff('Playback changed before the skip command could be applied.');
        return false;
      }

      this.store.update(next => {
        next.lastRequestUri = trackUri(current) || next.active.lastPlaybackUri || next.active.uri;
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
    const followingTrackUri = upcoming[1]?.uri ||
      playlistTracks.slice(position.nextOffset + 1).find(item => item?.uri)?.uri || null;
    let nextTrackIsrc = playlistTracks[position.nextOffset]?.isrc || null;
    if (!nextTrackIsrc && position.nextTrackUri) {
      try {
        nextTrackIsrc = (await this.spotify.getTrack(position.nextTrackUri))?.isrc || null;
      } catch (error) {
        this.logger.warn('[community-playlist] Could not resolve saved playlist continuation ISRC; exact-URI confirmation will still be used.', {
          uri: position.nextTrackUri,
          error: error.message
        });
      }
    }

    return {
      playlistUri: this.playlistUri,
      deviceId,
      currentTrackUri: currentUri,
      currentTrackProgressMs: Number(playback.progress_ms) || 0,
      currentTrackDurationMs: Number(playback.item?.duration_ms) || 0,
      nextOffset: position.nextOffset,
      nextTrackUri: position.nextTrackUri,
      nextTrackIsrc,
      followingTrackUri,
      playlistLength: playlistTracks.length,
      capturedAt: Date.now()
    };
  }

  async pump() {
    const state = this.store.get();
    // While waiting for the broadcaster's current playlist track to finish,
    // new redemptions only extend the pending FIFO; they must not interrupt it.
    if (state.mode === 'waiting-for-playlist') return;
    // Dispatch is allowed only at a known queue boundary. If an active request
    // disappears without an explicit skip/completion transition, do not let a
    // later redemption overwrite Spotify playback.
    const dispatchableModes = ['idle', 'request-complete', 'skipping'];
    if (state.active || !dispatchableModes.includes(state.mode)) {
      if (state.pending.length) {
        this.logger.warn('[community-playlist] Pending request dispatch blocked because the queue is not at a confirmed transition boundary.', {
          mode: state.mode,
          activeRequestId: state.active?.id || null,
          pendingRequestIds: state.pending.map(item => item.id)
        });
      }
      return;
    }

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
        next.mode = 'waiting-for-playlist';
      });
      this.logger.info('[community-playlist] Requests are waiting for the current playlist track to finish naturally.', {
        currentTrackUri: snapshot.currentTrackUri,
        nextTrackUri: snapshot.nextTrackUri,
        pendingRequestIds: this.store.get().pending.map(item => item.id)
      });
      return;
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
      const confirmed = await this.waitForTrack(request.uri, snapshot.deviceId, { requestId: request.id, playAttemptId, expectedIsrc: request.isrc });
      if (!confirmed) throw new Error('Spotify accepted the play command but the requested track was not confirmed.');
      this.store.update(next => {
        if (next.active?.id === request.id) {
          next.active.lastPlaybackUri = trackUri(confirmed) || request.uri;
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
    const {
      requestId = null,
      playAttemptId = null,
      expectedIsrc = null,
      expectedContextUri = null,
      expectedFollowingUri = null
    } = context;
    this.logger.info('[community-playlist] Playback confirmation started.', {
      controllerInstance: this.instanceId, playAttemptId, requestId, expectedUri: uri, deviceId
    });
    const deadline = Date.now() + this.playbackConfirmationTimeoutMs;
    let lastState = null;
    let lastObservedIsrc = null;
    let lastMetadataError = null;
    let lastQueueError = null;
    let nextQueueCheckAt = 0;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const state = await this.spotify.getPlaybackState();
        const observedIsrc = state?.item?.external_ids?.isrc || null;
        const matchedByIsrc = Boolean(expectedIsrc && state?.item?.uri !== uri &&
          await this.trackMatchesRequest(state, { uri, isrc: expectedIsrc }));
        if (state?.item?.uri && state.item.uri !== uri) {
          try {
            const metadata = await this.getTrackMetadata(state.item.uri);
            lastObservedIsrc = metadata?.isrc || observedIsrc;
          } catch (error) {
            lastMetadataError = error.message;
          }
        } else {
          lastObservedIsrc = observedIsrc;
        }
        let matchedByFollowingQueue = false;
        if (expectedContextUri && expectedFollowingUri &&
            state?.device?.id === deviceId && state?.context?.uri === expectedContextUri &&
            state?.is_playing === true && Date.now() >= nextQueueCheckAt) {
          nextQueueCheckAt = Date.now() + Math.max(1000, this.playbackConfirmationPollMs);
          try {
            const queue = await this.spotify.getQueue();
            matchedByFollowingQueue = queue?.[0]?.uri === expectedFollowingUri;
          } catch (error) {
            lastQueueError = error.message;
          }
        }
        if (state?.device?.id === deviceId &&
            (trackUri(state) === uri || matchedByIsrc || matchedByFollowingQueue) &&
            state.is_playing === true) {
          this.logger.info('[community-playlist] Playback confirmation matched.', {
            controllerInstance: this.instanceId, playAttemptId, requestId,
            expectedUri: uri, observedUri: trackUri(state), deviceId,
            matchedBy: matchedByFollowingQueue ? 'playlist-context-and-following-queue' :
              matchedByIsrc && trackUri(state) !== uri ? 'isrc' : 'uri',
            expectedIsrc, observedIsrc: lastObservedIsrc,
            expectedContextUri, expectedFollowingUri,
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
    const diagnostic = 'Expected track ' + uri + ' (ISRC ' + String(expectedIsrc || 'unknown') + ') on device ' + deviceId +
      '; last observed track ' + observedUri + ' (playable URI ' + playableUri +
      ') on device ' + observedDevice +
      '; observed_isrc=' + String(lastObservedIsrc || lastState?.item?.external_ids?.isrc || 'unresolved') +
      '; observed_metadata_error=' + String(lastMetadataError || 'none') +
      '; following_queue_error=' + String(lastQueueError || 'none') +
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

  async pollWaitingForPlaylist() {
    const state = this.store.get();
    const snapshot = state.snapshot;
    if (!snapshot || !state.pending.length || state.mode !== 'waiting-for-playlist') return;

    const playback = await this.spotify.getPlaybackState();
    if (!playback) return;
    if (playback.device?.id !== snapshot.deviceId) {
      this.handoff('Spotify changed playback devices while waiting for the current playlist track to finish.');
      return;
    }

    const snapshotPlaylistUri = snapshot.playlistUri || this.playlistUri;
    if (playback.context?.uri !== snapshotPlaylistUri) {
      this.handoff('Spotify playback left the saved playlist before the current track finished. Requests were preserved.');
      return;
    }

    const currentUri = trackUri(playback);
    let sameUriPlaylistAdvance = false;
    if (snapshot.nextTrackUri &&
        snapshot.nextTrackUri === snapshot.currentTrackUri &&
        currentUri === snapshot.currentTrackUri &&
        playback.is_playing === true) {
      // URI equality cannot distinguish consecutive duplicate playlist items.
      // Compare the upcoming item after the candidate next track instead.
      try {
        const queue = await this.spotify.getQueue();
        sameUriPlaylistAdvance = (queue?.[0]?.uri || null) === (snapshot.followingTrackUri || null);
      } catch (error) {
        this.logger.warn('[community-playlist] Could not verify a duplicate-track playlist boundary yet.', {
          error: error.message
        });
      }
    }
    const matchesNextTrack = Boolean(snapshot.nextTrackUri && (
      (currentUri === snapshot.nextTrackUri &&
        (currentUri !== snapshot.currentTrackUri || sameUriPlaylistAdvance)) ||
      (currentUri !== snapshot.currentTrackUri &&
        await this.trackMatchesRequest(playback, {
          uri: snapshot.nextTrackUri,
          isrc: snapshot.nextTrackIsrc || null
        }))
    ));
    const naturallyAdvanced = Boolean(matchesNextTrack && playback.is_playing === true);
    const naturallyEndedAtPlaylistEnd = Boolean(
      !snapshot.nextTrackUri &&
      currentUri === snapshot.currentTrackUri &&
      playback.is_playing === false &&
      Number(snapshot.currentTrackDurationMs) > 0 &&
      Number(playback.progress_ms) >= Number(snapshot.currentTrackDurationMs) - 2000
    );
    if (currentUri === snapshot.currentTrackUri && !naturallyEndedAtPlaylistEnd && !sameUriPlaylistAdvance) return;
    // If Spotify has advanced to the intended next item but it is paused,
    // preserve that position and wait for playback to resume before dispatch.
    if (matchesNextTrack && !playback.is_playing) return;
    if (!naturallyAdvanced && !naturallyEndedAtPlaylistEnd) {
      this.handoff('Spotify moved away from the expected playlist boundary while waiting for the current track to finish. Requests were preserved.');
      return;
    }

    this.logger.info('[community-playlist] The original playlist track finished naturally; starting the queued viewer requests.', {
      previousTrackUri: snapshot.currentTrackUri,
      nextTrackUri: snapshot.nextTrackUri,
      pendingRequestIds: state.pending.map(item => item.id)
    });
    this.store.update(next => { next.mode = 'request-complete'; });
    await this.pump();
  }

  async poll() {
    if (!this.started) return;
    const currentState = this.store.get();
    if (!currentState.active) {
      if (currentState.mode === 'waiting-for-playlist') {
        await this.pollWaitingForPlaylist();
      } else if (currentState.mode !== 'handoff' && currentState.pending.length) {
        await this.pump();
      }
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
      playback.context?.uri === (snapshot.playlistUri || this.playlistUri);
    const matchesActiveRequest = await this.trackMatchesRequest(playback, active);

    // A viewer may request the same recording that is next in the playlist.
    // If Spotify still reports that recording as the active item but progress
    // has not reached its end, keep it classified as the viewer request rather
    // than mistaking its matching URI/context for a playlist handoff.
    if (returnedToPlaylist && !(matchesActiveRequest && !this.hasNaturallyCompleted(active))) {
      if (!this.hasNaturallyCompleted(active)) {
        const staleReadGraceMs = Math.max(10000, this.pollIntervalMs * 3);
        if (Date.now() - (Number(active.startedAt) || Date.now()) <= staleReadGraceMs) {
          this.logger.warn('[community-playlist] Ignoring a playlist-state read that does not prove the active viewer request completed naturally.', {
            requestId: active.id,
            lastProgressMs: active.lastProgressMs || 0,
            durationMs: active.durationMs || 0
          });
          return;
        }
        this.handoff('Spotify left the active viewer request before its natural completion could be confirmed. Remaining requests were preserved.');
        return;
      }

      const hasPending = state.pending.length > 0;
      this.logger.info('[community-playlist] Active viewer request completed; Spotify returned to the expected playlist continuation.');
      this.store.update(next => {
        next.lastRequestUri = next.active.lastPlaybackUri || next.active.uri;
        next.active = null;
        if (!hasPending) next.snapshot = null;
        next.mode = 'request-complete';
      });
      await this.pump();
      return;
    }

    if (matchesActiveRequest) {
      const progress = Number(playback.progress_ms) || 0;
      const duration = Number(playback.item?.duration_ms) || active.durationMs || 0;
      this.store.update(next => {
        if (!next.active || next.active.id !== active.id) return;
        next.active.lastPlaybackUri = currentUri || next.active.lastPlaybackUri || next.active.uri;
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
      state.lastRequestUri = state.active?.lastPlaybackUri || state.active?.uri || state.lastRequestUri;
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
    const allowedRequestUri = state.active?.lastPlaybackUri || state.active?.uri || state.lastRequestUri;
    if (currentUri && currentUri !== allowedRequestUri && currentUri !== snapshot.nextTrackUri) {
      this.handoff('Playback changed manually before playlist restoration; leaving it untouched.');
      return;
    }
    const snapshotPlaylistUri = snapshot.playlistUri || this.playlistUri;
    if (currentUri === snapshot.nextTrackUri && playback?.context?.uri === snapshotPlaylistUri) {
      this.store.update(next => {
        next.snapshot = null;
        next.mode = 'idle';
      });
      return;
    }

    await this.spotify.playPlaylistAt(snapshotPlaylistUri, snapshot.nextOffset, snapshot.deviceId);
    const restored = await this.waitForTrack(snapshot.nextTrackUri, snapshot.deviceId, {
      expectedIsrc: snapshot.nextTrackIsrc || null,
      expectedContextUri: snapshotPlaylistUri,
      expectedFollowingUri: snapshot.followingTrackUri || null
    });
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
      if (state.snapshot && state.mode === 'waiting-for-playlist' && state.pending.length) {
        // A restart must preserve the wait rather than discard the captured
        // playlist position or begin requests by interrupting the current item.
        await this.pollWaitingForPlaylist();
        return;
      }
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
    const returnedToPlaylist = playback?.device?.id === state.snapshot.deviceId &&
      trackUri(playback) === state.snapshot.nextTrackUri &&
      playback.context?.uri === (state.snapshot.playlistUri || this.playlistUri);
    const matchesActiveRequest = playback?.device?.id === state.snapshot.deviceId &&
      await this.trackMatchesRequest(playback, state.active);

    if (matchesActiveRequest && !(returnedToPlaylist && this.hasNaturallyCompleted(state.active))) {
      this.store.update(next => {
        next.active.lastPlaybackUri = trackUri(playback) || next.active.lastPlaybackUri || next.active.uri;
        next.active.lastProgressMs = Math.max(next.active.lastProgressMs || 0, Number(playback.progress_ms) || 0);
        next.active.durationMs = Number(playback.item?.duration_ms) || next.active.durationMs || 0;
        next.mode = playback.is_playing ? 'playing-request' : 'paused-request';
      });
      return;
    }

    if (returnedToPlaylist) {
      if (!this.hasNaturallyCompleted(state.active)) {
        this.handoff('The previous session reached the playlist continuation without persisted evidence that the active viewer request completed naturally. Requests were preserved for manual recovery.');
        return;
      }
      const hasPending = state.pending.length > 0;
      this.store.update(next => {
        next.lastRequestUri = next.active.lastPlaybackUri || next.active.uri;
        next.active = null;
        if (!hasPending) next.snapshot = null;
        next.mode = 'request-complete';
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
