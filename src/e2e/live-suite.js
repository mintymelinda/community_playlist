function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  const suffix = lastError ? ' Last API error: ' + lastError.message : '';
  throw new Error('Timed out waiting for ' + description + '.' + suffix);
}

function chatNotification(broadcasterId, chatterId, messageId, badges = []) {
  return {
    metadata: { message_type: 'notification', message_id: messageId },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: broadcasterId,
        chatter_user_id: chatterId,
        chatter_user_name: 'E2E Test',
        badges,
        message: { text: '!skip' }
      }
    }
  };
}

export function createLiveE2ESuite(app) {
  async function preflight() {
    assert(app.started, 'Start the controller with communityPlaylist.start() first.');
    assert(app.eventSub?.socket?.readyState === 1, 'Twitch EventSub WebSocket is not connected.');
    assert(app.powerUp?.id, 'No eligible Twitch Custom Power-up was selected.');

    const identity = await app.twitchAuth.validate();
    assert(String(identity.user_id) === String(app.broadcasterId), 'Twitch OAuth identity does not match the broadcaster.');

    const playback = await app.spotify.getPlaybackState();
    assert(playback?.is_playing, 'Start Spotify playback before running the E2E suite.');
    assert(playback.context?.uri === app.config.playlistUri, 'The configured Spotify playlist must be playing.');
    const state = app.store.get();
    assert(state.mode !== 'handoff', 'Resolve the controller handoff state before running E2E tests.');
    assert(!state.active && state.pending.length === 0 && !state.snapshot, 'The application request queue must be empty before running E2E tests.');

    const snapshot = await app.coordinator.captureSnapshot();
    assert(snapshot.nextOffset < snapshot.playlistLength, 'The playlist must have at least one upcoming track to restore.');
    const [trackX, trackY] = await Promise.all([
      app.spotify.resolveTrack(app.config.e2eTrackX),
      app.spotify.resolveTrack(app.config.e2eTrackY)
    ]);
    assert(trackX.uri !== trackY.uri, 'E2E_TRACK_X and E2E_TRACK_Y must resolve to different Spotify tracks.');
    assert(trackX.uri !== snapshot.currentTrackUri && trackY.uri !== snapshot.currentTrackUri, 'Choose test tracks other than the currently playing playlist track.');
    assert(trackX.uri !== snapshot.nextTrackUri && trackY.uri !== snapshot.nextTrackUri, 'Choose test tracks other than the playlist track that must be restored.');

    const queue = await app.spotify.getQueue();
    assert(queue[0]?.uri === snapshot.nextTrackUri, 'Spotify upcoming queue did not match the playlist continuation at E2E preflight.');
    return { snapshot, trackX, trackY, queue };
  }

  async function injectRedemption(id, input) {
    return app.eventSub.handleNotification({
      metadata: { message_type: 'notification', message_id: id },
      payload: {
        subscription: { type: 'channel.custom_power_up_redemption.add' },
        event: {
          id,
          broadcaster_user_id: app.broadcasterId,
          user_id: 'community-playlist-e2e-viewer',
          user_name: 'E2E Test Viewer',
          user_input: input,
          status: 'fulfilled',
          custom_power_up: { id: app.powerUp.id }
        }
      }
    });
  }

  async function injectAuthorizedSkip(id, chatterId, badges = []) {
    return app.eventSub.handleNotification(chatNotification(app.broadcasterId, chatterId, id, badges));
  }

  async function waitForTrack(uri, label) {
    return waitFor(label + ' to become the Spotify current track', async () => {
      const playback = await app.spotify.getPlaybackState();
      return playback?.item?.uri === uri ? playback : null;
    });
  }

  async function runPlaybackSequence() {
    const checks = [];
    let completed = false;
    const runId = 'community-playlist-e2e-' + crypto.randomUUID();
    try {
      const { snapshot, trackX, trackY, queue } = await preflight();
      checks.push({ name: 'Twitch and Spotify authentication', passed: true });
      checks.push({ name: 'Playlist and Connect device preflight', passed: true });

      const playlistBefore = (await app.spotify.getPlaylistItems(app.coordinator.playlistId)).map(item => item?.uri || null);
      const firstId = runId + '-redemption-x';
      const secondId = runId + '-redemption-y';

      await injectRedemption(firstId, app.config.e2eTrackX);
      await waitForTrack(trackX.uri, 'request X');
      let state = app.store.get();
      assert(state.active?.id === firstId, 'Request X was not recorded as the active request.');
      assert(state.snapshot?.nextTrackUri === snapshot.nextTrackUri, 'The coordinator did not preserve the preflight playlist continuation.');
      checks.push({ name: 'First synthetic Twitch redemption interrupts Spotify playlist', passed: true });

      await injectRedemption(secondId, app.config.e2eTrackY);
      state = app.store.get();
      assert(state.active?.id === firstId, 'The second redemption unexpectedly replaced request X.');
      assert(state.pending.length === 1 && state.pending[0].id === secondId, 'Request Y was not held in the application FIFO.');
      checks.push({ name: 'Second redemption waits in the application FIFO', passed: true });

      await injectAuthorizedSkip(runId + '-unauthorized-skip', 'e2e-unprivileged-viewer');
      const afterUnauthorized = await app.spotify.getPlaybackState();
      assert(afterUnauthorized?.item?.uri === trackX.uri, 'An unauthorized !skip changed Spotify playback.');
      assert(app.store.get().active?.id === firstId, 'An unauthorized !skip changed the active request.');
      checks.push({ name: 'Unauthorized !skip is rejected', passed: true });

      await injectAuthorizedSkip(runId + '-skip-x', app.broadcasterId);
      await waitForTrack(trackY.uri, 'request Y after broadcaster !skip');
      assert(app.store.get().active?.id === secondId, 'Broadcaster !skip did not advance to request Y.');
      checks.push({ name: 'Broadcaster !skip advances to request Y', passed: true });

      await injectAuthorizedSkip(runId + '-skip-y', app.broadcasterId);
      await waitFor('the saved playlist continuation to resume', async () => {
        const [playback, current] = await Promise.all([
          app.spotify.getPlaybackState(),
          Promise.resolve(app.store.get())
        ]);
        return playback?.context?.uri === app.config.playlistUri &&
          playback?.item?.uri === snapshot.nextTrackUri &&
          current.mode === 'idle' &&
          !current.active &&
          current.pending.length === 0 &&
          !current.snapshot;
      });
      checks.push({ name: 'Playlist resumes at the exact saved next track', passed: true });

      const [playlistAfter, queueAfter] = await Promise.all([
        app.spotify.getPlaylistItems(app.coordinator.playlistId),
        app.spotify.getQueue()
      ]);
      const playlistAfterUris = playlistAfter.map(item => item?.uri || null);
      assert(JSON.stringify(playlistAfterUris) === JSON.stringify(playlistBefore), 'The Spotify playlist items changed during the test.');
      checks.push({ name: 'Spotify playlist was not mutated', passed: true });

      const expectedQueue = queue.slice(1).map(item => item?.uri || null);
      const actualQueue = queueAfter.map(item => item?.uri || null);
      assert(JSON.stringify(actualQueue) === JSON.stringify(expectedQueue), 'Spotify upcoming queue did not advance by exactly the restored playlist track.');
      checks.push({ name: 'Upcoming playlist queue continues after the restored track', passed: true });

      completed = true;
      return {
        passed: true,
        runId,
        checks,
        playback: {
          requestX: trackX.uri,
          requestY: trackY.uri,
          restoredTrack: snapshot.nextTrackUri
        }
      };
    } catch (error) {
      checks.push({ name: 'Playback sequence', passed: false, error: error.message });
      return { passed: false, runId, checks };
    } finally {
      if (!completed) {
        const state = app.store.get();
        if (state.active || state.snapshot) {
          app.coordinator.handoff('The E2E suite stopped before it could verify safe playlist restoration. Requests were preserved for manual recovery.');
        }
      }
    }
  }

  async function waitForRealRedemption(timeoutMs = 120000) {
    assert(app.started && app.eventSub?.socket?.readyState === 1, 'Connect the controller to Twitch EventSub first.');
    const existing = new Set(app.store.get().redemptionJobs.map(job => job.id));
    console.info('[community-playlist:e2e] Redeem the configured Custom Power-up on Twitch now. This test uses a real redemption and may spend Bits.');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = app.store.get().redemptionJobs.find(item => !existing.has(item.id));
      if (job && (job.status === 'queued' || job.status === 'ignored')) {
        return { id: job.id, status: job.status, attempts: job.attempts };
      }
      await delay(500);
    }
    throw new Error('Timed out waiting for a real Twitch Custom Power-up redemption.');
  }

  return {
    preflight,
    runPlaybackSequence,
    waitForRealRedemption
  };
}
