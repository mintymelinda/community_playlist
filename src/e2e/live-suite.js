import { isAuthorizedSkip, isSkipCommand } from '../twitch/eventsub.js';

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
  let playbackPreparation = null;

  async function restorePlaybackSettings() {
    const saved = playbackPreparation;
    if (!saved) return;

    await app.spotify.setShuffle(saved.shuffle, saved.deviceId);
    await app.spotify.setRepeat(saved.repeat, saved.deviceId);
    await waitFor('the original Spotify shuffle and repeat settings to be restored', async () => {
      const playback = await app.spotify.getPlaybackState();
      return playback &&
        playback.shuffle_state === saved.shuffle &&
        playback.repeat_state === saved.repeat
        ? playback
        : null;
    });
    playbackPreparation = null;
  }

  async function preparePlayback() {
    if (playbackPreparation?.ready) return playbackPreparation;

    const initialPlayback = await app.spotify.getPlaybackState();
    const devices = initialPlayback?.device?.id ? [] : await app.spotify.getDevices();
    const activeDeviceId = initialPlayback?.device?.id ||
      devices.find(device => device.is_active)?.id ||
      devices[0]?.id ||
      '';
    const deviceId = app.config.spotifyDeviceId || activeDeviceId;
    assert(deviceId, 'No Spotify Connect device is available. Open Spotify on the device to use for the test.');
    if (app.config.spotifyDeviceId && initialPlayback?.device?.id &&
        app.config.spotifyDeviceId !== initialPlayback.device.id) {
      throw new Error('SPOTIFY_DEVICE_ID must be the active Spotify playback device so its original shuffle and repeat settings can be saved.');
    }

    const playlistUri = app.config.playlistUri ||
      (initialPlayback?.context?.type === 'playlist' ? initialPlayback.context.uri : '');
    assert(playlistUri, 'Set SPOTIFY_PLAYLIST_URI or start a Spotify playlist first so the test can use the current playlist.');
    const playlistId = app.spotify.extractPlaylistId(playlistUri);

    app.playlistUri = playlistUri;
    app.playlistId = playlistId;
    app.coordinator.playlistUri = playlistUri;
    app.coordinator.playlistId = playlistId;

    const state = app.store.get();
    assert(state.mode !== 'handoff', 'Resolve the controller handoff state before running E2E tests.');
    assert(!state.active && !state.snapshot, 'The isolated E2E request queue still has an active request or playlist snapshot. Recover it before starting another test.');
    // This store uses a dedicated E2E key; clearing it does not touch the
    // production request queue or any Spotify playlist contents.
    app.store.clear();

    const saved = {
      deviceId,
      shuffle: initialPlayback?.shuffle_state === true,
      repeat: ['track', 'context'].includes(initialPlayback?.repeat_state)
        ? initialPlayback.repeat_state
        : 'off',
      playlistUri,
      ready: false
    };
    playbackPreparation = saved;

    try {
      if (saved.shuffle) await app.spotify.setShuffle(false, deviceId);
      if (saved.repeat !== 'off') await app.spotify.setRepeat('off', deviceId);

      const playlistAlreadyLoaded =
        initialPlayback?.context?.type === 'playlist' &&
        initialPlayback.context.uri === playlistUri;

      if (!playlistAlreadyLoaded) {
        await app.spotify.playPlaylistAt(playlistUri, 0, deviceId);
      } else if (!initialPlayback.is_playing) {
        await app.spotify.resumePlayback(deviceId);
      }

      await waitFor('the selected playlist to be playing with shuffle and repeat off', async () => {
        const playback = await app.spotify.getPlaybackState();
        return playback?.device?.id === deviceId &&
          playback?.context?.type === 'playlist' &&
          playback.context.uri === playlistUri &&
          playback.is_playing &&
          playback.shuffle_state === false &&
          playback.repeat_state === 'off'
          ? playback
          : null;
      });
      saved.ready = true;
      return saved;
    } catch (error) {
      try {
        await restorePlaybackSettings();
      } catch (restoreError) {
        throw new Error(error.message + ' Spotify playback settings could not be restored: ' + restoreError.message);
      }
      throw error;
    }
  }

  async function preflight() {
    assert(app.started, 'Start the controller with communityPlaylist.start() first.');
    assert(app.eventSub?.socket?.readyState === 1, 'Twitch EventSub WebSocket is not connected.');
    assert(app.powerUp?.id, 'No eligible Twitch Custom Power-up was selected.');

    const identity = await app.twitchAuth.validate();
    assert(String(identity.user_id) === String(app.broadcasterId), 'Twitch OAuth identity does not match the broadcaster.');

    await preparePlayback();
    try {
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
      return { snapshot, trackX, trackY, queue, playlistUri: app.playlistUri };
    } catch (error) {
      try {
        await restorePlaybackSettings();
      } catch (restoreError) {
        throw new Error(error.message + ' Spotify playback settings could not be restored: ' + restoreError.message);
      }
      throw error;
    }
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


  async function verifyProviderTokenRefresh() {
    assert(app.started, 'Start the controller before testing OAuth token refresh.');
    assert(app.twitchAuth.session?.refreshToken, 'Twitch refresh token is not available; reauthorize the broadcaster.');
    assert(app.spotifyAuth.session?.refreshToken, 'Spotify refresh token is not available; reauthorize Spotify.');

    app.twitchAuth.session.expiresAt = 0;
    app.twitchAuth.tokenStore.save(app.twitchAuth.session);
    await app.twitchAuth.getAccessToken();
    const twitchIdentity = await app.twitchAuth.validate();
    assert(String(twitchIdentity.user_id) === String(app.broadcasterId), 'Twitch identity changed after token refresh.');
    assert(app.twitchAuth.session.expiresAt > Date.now(), 'Twitch token expiry was not updated after refresh.');

    app.spotifyAuth.session.expiresAt = 0;
    app.spotifyAuth.tokenStore.save(app.spotifyAuth.session);
    await app.spotifyAuth.getAccessToken();
    const playback = await app.spotify.getPlaybackState();
    assert(playback !== null, 'Spotify API did not return playback state after token refresh.');
    assert(app.spotifyAuth.session.expiresAt > Date.now(), 'Spotify token expiry was not updated after refresh.');

    return {
      passed: true,
      checks: [
        { name: 'Twitch refresh-token rotation and broadcaster validation', passed: true },
        { name: 'Spotify PKCE refresh-token grant and playback API access', passed: true }
      ]
    };
  }

  async function verifyEventSubReconnect(timeoutMs = 45000) {
    assert(app.eventSub?.socket?.readyState === 1, 'Twitch EventSub WebSocket is not connected.');
    const eventSub = app.eventSub;
    const previousSocket = eventSub.socket;
    const previousSessionId = eventSub.sessionId;
    assert(previousSessionId, 'The current EventSub session ID is unavailable.');

    previousSocket.close(4000, 'Requested by live E2E reconnect test');

    const session = await waitFor('a new EventSub session and completed subscription registration', async () => {
      if (
        eventSub.socket &&
        eventSub.socket !== previousSocket &&
        eventSub.socket.readyState === 1 &&
        eventSub.sessionId &&
        eventSub.sessionId !== previousSessionId &&
        eventSub.subscribedSessionId === eventSub.sessionId
      ) {
        return { sessionId: eventSub.sessionId };
      }
      return null;
    }, timeoutMs);

    const response = await app.twitchAuth.api('/eventsub/subscriptions?status=enabled&first=100');
    const types = (response.data || [])
      .filter(subscription =>
        subscription.transport?.method === 'websocket' &&
        subscription.transport?.session_id === session.sessionId
      )
      .map(subscription => subscription.type);
    assert(types.includes('channel.custom_power_up_redemption.add'), 'Twitch did not register the redemption subscription on the new session.');
    assert(types.includes('channel.chat.message'), 'Twitch did not register the chat subscription on the new session.');

    return {
      passed: true,
      checks: [
        { name: 'Unexpected WebSocket close reconnects', passed: true },
        { name: 'Both EventSub subscriptions are active on the replacement session', passed: true, subscriptionTypes: types }
      ]
    };
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


  async function waitForRealSkipMessage(expectedAuthorized, timeoutMs = 120000) {
    assert(app.eventSub?.socket?.readyState === 1, 'Connect the controller to Twitch EventSub first.');
    const eventSub = app.eventSub;
    const hadOwnHandler = Object.hasOwn(eventSub, 'handleNotification');
    const previousHandler = eventSub.handleNotification;
    const originalHandler = previousHandler.bind(eventSub);
    let observed = null;

    eventSub.handleNotification = async message => {
      const type = message.payload?.subscription?.type;
      const event = message.payload?.event;
      if (type !== 'channel.chat.message' || !isSkipCommand(event)) {
        return originalHandler(message);
      }

      const authorized = isAuthorizedSkip(event, app.broadcasterId);
      let delivered = false;
      const previousCallback = eventSub.onChatCommand;
      eventSub.onChatCommand = async command => {
        delivered = true;
        return previousCallback(command);
      };

      try {
        await originalHandler(message);
      } finally {
        eventSub.onChatCommand = previousCallback;
      }

      observed = {
        authorized,
        delivered,
        chatterId: event.chatter_user_id,
        messageId: message.metadata?.message_id || event.message_id || null
      };
    };

    console.info(expectedAuthorized
      ? '[community-playlist:e2e] Send !skip in Twitch chat from the broadcaster or an authorized moderator now.'
      : '[community-playlist:e2e] Send !skip in Twitch chat from an ordinary viewer who is not a moderator now.');

    try {
      const result = await waitFor(
        expectedAuthorized ? 'an authorized real Twitch !skip message' : 'an unauthorized real Twitch !skip message',
        async () => observed,
        timeoutMs
      );
      assert(result.authorized === expectedAuthorized,
        expectedAuthorized
          ? 'The observed !skip message was not sent by the broadcaster or a moderator.'
          : 'The observed !skip message was sent by the broadcaster or a moderator.');
      assert(result.delivered === expectedAuthorized,
        expectedAuthorized
          ? 'The authorized Twitch !skip message was not delivered to the coordinator.'
          : 'An unauthorized Twitch !skip message reached the coordinator.');
      return result;
    } finally {
      if (hadOwnHandler) eventSub.handleNotification = previousHandler;
      else delete eventSub.handleNotification;
    }
  }

  async function runRealChatSkipTest(timeoutMs = 120000) {
    const checks = [];
    let completed = false;
    const runId = 'community-playlist-live-chat-' + crypto.randomUUID();
    try {
      const { snapshot, trackX, trackY } = await preflight();
      const playlistBefore = (await app.spotify.getPlaylistItems(app.coordinator.playlistId)).map(item => item?.uri || null);
      const firstId = runId + '-redemption-x';
      const secondId = runId + '-redemption-y';

      await injectRedemption(firstId, app.config.e2eTrackX);
      await waitForTrack(trackX.uri, 'request X for the real chat skip test');
      await injectRedemption(secondId, app.config.e2eTrackY);
      assert(app.store.get().active?.id === firstId, 'Request X was not active before the live chat test.');
      assert(app.store.get().pending[0]?.id === secondId, 'Request Y was not pending before the live chat test.');
      checks.push({ name: 'Prepared X and Y through the live Spotify playback path', passed: true });

      const unauthorized = await waitForRealSkipMessage(false, timeoutMs);
      const [afterUnauthorizedPlayback, afterUnauthorizedState] = await Promise.all([
        app.spotify.getPlaybackState(),
        Promise.resolve(app.store.get())
      ]);
      assert(afterUnauthorizedPlayback?.item?.uri === trackX.uri, 'An unauthorized real Twitch !skip changed Spotify playback.');
      assert(afterUnauthorizedState.active?.id === firstId, 'An unauthorized real Twitch !skip changed the active request.');
      assert(afterUnauthorizedState.pending[0]?.id === secondId, 'An unauthorized real Twitch !skip changed the pending request.');
      checks.push({ name: 'A real non-moderator !skip is ignored', passed: true, chatterId: unauthorized.chatterId });

      const authorized = await waitForRealSkipMessage(true, timeoutMs);
      await waitForTrack(trackY.uri, 'request Y after a real broadcaster/moderator !skip');
      assert(app.store.get().active?.id === secondId, 'The real broadcaster/moderator !skip did not advance to request Y.');
      checks.push({ name: 'A real broadcaster/moderator !skip advances to Y', passed: true, chatterId: authorized.chatterId });

      await app.coordinator.skip();
      await waitFor('the saved playlist continuation to resume', async () => {
        const [playback, state] = await Promise.all([
          app.spotify.getPlaybackState(),
          Promise.resolve(app.store.get())
        ]);
        return playback?.context?.uri === app.config.playlistUri &&
          playback?.item?.uri === snapshot.nextTrackUri &&
          state.mode === 'idle' &&
          !state.active &&
          state.pending.length === 0 &&
          !state.snapshot;
      });
      const playlistAfter = (await app.spotify.getPlaylistItems(app.coordinator.playlistId)).map(item => item?.uri || null);
      assert(JSON.stringify(playlistAfter) === JSON.stringify(playlistBefore), 'The Spotify playlist changed during the real chat test.');
      checks.push({ name: 'Playlist restored to its saved next track without playlist mutation', passed: true });

      completed = true;
      return { passed: true, runId, checks };
    } catch (error) {
      checks.push({ name: 'Real Twitch chat skip sequence', passed: false, error: error.message });
      return { passed: false, runId, checks };
    } finally {
      if (!completed) {
        const state = app.store.get();
        if (state.active || state.snapshot) {
          app.coordinator.handoff('The real chat skip E2E test stopped before playlist restoration could be verified. Requests were preserved for manual recovery.');
        }
      }
    }
  }

  return {
    preflight,
    runPlaybackSequence,
    runRealChatSkipTest,
    verifyProviderTokenRefresh,
    verifyEventSubReconnect,
    waitForRealRedemption
  };
}
