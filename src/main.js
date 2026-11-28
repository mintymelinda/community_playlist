import { QueueStore } from './lib/queue-store.js';
import { TokenStore } from './lib/token-store.js';
import { TwitchAuth } from './auth/twitch-auth.js';
import { SpotifyAuth } from './auth/spotify-auth.js';
import { SpotifyClient } from './spotify/client.js';
import { TwitchEventSub } from './twitch/eventsub.js';
import { RedemptionProcessor } from './twitch/redemption-processor.js';
import { PlaybackCoordinator } from './playback/coordinator.js';

const AUTO_START_KEY = 'community-playlist-auto-start';

function validateConfig(config) {
  for (const key of ['twitchClientId', 'spotifyClientId', 'spotifyRedirectUri']) {
    if (!config[key] || String(config[key]).includes('YOUR_')) {
      throw new Error('Set ' + key + ' in config.local.js before starting the controller.');
    }
  }
  const redirect = new URL(config.spotifyRedirectUri);
  if (!config.provisioned && (redirect.origin !== location.origin || redirect.pathname !== location.pathname || redirect.search || redirect.hash)) {
    throw new Error('spotifyRedirectUri must exactly match the current page URL, without a query string or fragment.');
  }
}

class CommunityPlaylistApp {
  constructor(config) {
    this.config = config;
    this.e2eMode = config.e2eMode === true &&
      location.protocol === 'http:' &&
      location.hostname === '127.0.0.1';
    this.autoStartKey = this.e2eMode ? 'community-playlist-e2e-auto-start' : AUTO_START_KEY;
    const queueKey = this.e2eMode ? 'community-playlist-e2e-queue-v1' : 'community-playlist-queue-v1';
    const storagePrefix = this.e2eMode ? 'community-playlist-e2e-' : 'community-playlist-';
    const authStorage = config.provisioned ? localStorage : sessionStorage;
    if (config.provisioned) {
      if (config.twitchToken) localStorage.setItem('community-playlist-twitch-token', JSON.stringify(config.twitchToken));
      if (config.spotifyToken) localStorage.setItem('community-playlist-spotify-token', JSON.stringify(config.spotifyToken));
    }
    if (this.e2eMode && sessionStorage.getItem('community-playlist-e2e-initialized') !== '1') {
      localStorage.removeItem(queueKey);
      sessionStorage.setItem('community-playlist-e2e-initialized', '1');
    }
    this.store = new QueueStore(localStorage, queueKey, config.maxPendingRequests || 100);
    this.twitchAuth = new TwitchAuth({
      clientId: config.twitchClientId,
      scopes: ['bits:read', 'user:read:chat', 'user:write:chat'],
      tokenStore: new TokenStore(authStorage, storagePrefix + 'twitch-token')
    });
    const spotifyTokenStore = new TokenStore(authStorage, storagePrefix + 'spotify-token');
    const spotifyPkceStore = new TokenStore(sessionStorage, storagePrefix + 'spotify-pkce');
    this.spotifyAuth = new SpotifyAuth({
      clientId: config.spotifyClientId,
      redirectUri: config.spotifyRedirectUri,
      scopes: [
        'user-read-playback-state',
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-modify-playback-state'
      ],
      tokenStore: spotifyTokenStore,
      pkceStore: spotifyPkceStore
    });
    this.spotify = new SpotifyClient({ auth: this.spotifyAuth });
    this.playlistUri = String(config.playlistUri || '').trim();
    this.playlistId = this.playlistUri ? this.spotify.extractPlaylistId(this.playlistUri) : '';
    this.coordinator = new PlaybackCoordinator({
      spotify: this.spotify,
      store: this.store,
      playlistUri: this.playlistUri,
      playlistId: this.playlistId,
      deviceId: config.spotifyDeviceId || '',
      pollIntervalMs: Math.max(1000, Number(config.pollIntervalMs) || 2000)
    });
    this.redemptionProcessor = new RedemptionProcessor({
      store: this.store,
      spotify: this.spotify,
      coordinator: this.coordinator
    });
    this.eventSub = null;
    this.started = false;
    this.controllerLockRelease = null;
    this.controllerLockTask = null;
    this.broadcasterId = null;
    this.twitchIdentity = null;
    this.powerUp = null;
    this.debugEnabled = new URLSearchParams(location.search).get('debug') === 'true';
    this.debugQueue = Promise.resolve();
    this.lastDebugMessageAt = 0;
  }

  async acquireControllerLock() {
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager?.request) {
      throw new Error('This browser does not support Web Locks, which are required to prevent multiple controller tabs from issuing competing Spotify playback commands.');
    }

    let resolveAcquired;
    let rejectAcquired;
    const acquired = new Promise((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    const held = new Promise(resolve => { this.controllerLockRelease = resolve; });
    const lockName = 'community-playlist-controller';

    this.controllerLockTask = lockManager.request(lockName, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) {
        rejectAcquired(new Error('Another Community Playlist controller tab is already running. Stop it before starting this tab.'));
        return;
      }
      resolveAcquired();
      await held;
    }).catch(error => {
      rejectAcquired(error);
    });

    try {
      await acquired;
    } catch (error) {
      this.controllerLockRelease?.();
      this.controllerLockRelease = null;
      await this.controllerLockTask;
      this.controllerLockTask = null;
      throw error;
    }
  }

  async releaseControllerLock() {
    this.controllerLockRelease?.();
    this.controllerLockRelease = null;
    await this.controllerLockTask?.catch(() => {});
    this.controllerLockTask = null;
  }

  async start() {
    if (this.started) return this.status();
    validateConfig(this.config);
    await this.acquireControllerLock();

    try {
      return await this.startWithControllerLock();
    } catch (error) {
      await this.releaseControllerLock();
      throw error;
    }
  }

  async startWithControllerLock() {
    await this.spotifyAuth.handleRedirect();
    if (!this.spotifyAuth.session?.accessToken) {
      sessionStorage.setItem(this.autoStartKey, '1');
      await this.spotifyAuth.beginAuthorization();
      return { mode: 'spotify-authorization' };
    }

    this.twitchIdentity = await this.twitchAuth.validate();
    // The Twitch account that completes OAuth is the channel identity. The
    // application owner/client ID is not a separate chat user or moderator.
    this.broadcasterId = this.twitchIdentity.user_id;

    const powerUp = await this.discoverPowerUp();
    this.powerUp = powerUp;

    await this.coordinator.start();
    await this.redemptionProcessor.retryPending();
    this.eventSub = new TwitchEventSub({
      twitchAuth: this.twitchAuth,
      broadcasterId: this.broadcasterId,
      powerUpId: powerUp.id,
      store: this.store,
      onRedemption: request => this.redemptionProcessor.accept(request),
      onChatCommand: command => this.handleChatCommand(command),
      onDebug: details => this.debugChat(details)
    });

    try {
      await this.eventSub.connect();
    } catch (error) {
      this.eventSub.stop();
      this.coordinator.stop();
      throw error;
    }

    this.started = true;
    console.info('[community-playlist] Controller is running. Power-up: ' + powerUp.title + '. Playlist: ' + (this.playlistUri || 'selected from current Spotify playback'));
    this.debugChat({ event: 'controller-started', channel: this.twitchIdentity.login, broadcasterId: this.broadcasterId, powerUpId: powerUp.id, eventSubSessionId: this.eventSub.sessionId, debug: this.debugEnabled });
    return this.status();
  }

  async discoverPowerUp() {
    const { data = [] } = await this.twitchAuth.api('/bits/custom_power_ups?broadcaster_id=' + encodeURIComponent(this.broadcasterId));
    const eligible = data.filter(item => item.is_enabled && item.is_user_input_required && !item.is_paused && item.is_in_stock);
    const powerUp = this.config.powerUpId
      ? eligible.find(item => item.id === this.config.powerUpId)
      : eligible.length === 1 ? eligible[0] : null;

    if (!powerUp) {
      if (this.config.powerUpId) throw new Error('Configured Power-up must be enabled, in stock, and require viewer text input.');
      if (!eligible.length) throw new Error('No enabled, in-stock Custom Power-up requiring viewer text input was found.');
      throw new Error('Multiple eligible Custom Power-ups found. Set powerUpId in config.local.js.');
    }
    return powerUp;
  }

  async handleChatCommand(command) {
    if (command.command !== 'skip') return;
    console.info('[community-playlist] Authorized !skip received.', { user: command.user || null });
    this.debugChat({ event: 'skip-command-received', user: command.user || null, playback: this.coordinator.status() });
    try {
      const skipped = await this.coordinator.skip();
      console.info('[community-playlist] !skip processing finished.', { skipped, playback: this.coordinator.status() });
      this.debugChat({ event: 'skip-command-result', skipped, playback: this.coordinator.status(), reason: skipped ? 'skip accepted' : 'Spotify playback state/device/playlist context did not allow a skip' });
    } catch (error) {
      console.error('[community-playlist] !skip failed.', error);
      this.debugChat({ event: 'skip-command-error', error: error.message, playback: this.coordinator.status() });
      throw error;
    }
  }

  debugChat(details) {
    if (!this.debugEnabled || !this.twitchIdentity?.user_id) return Promise.resolve();
    const text = '[CP debug] ' + (typeof details === 'string' ? details : JSON.stringify(details));
    const message = text.length > 450 ? text.slice(0, 447) + '...' : text;
    this.debugQueue = this.debugQueue.catch(() => {}).then(async () => {
      const wait = Math.max(0, 1100 - (Date.now() - this.lastDebugMessageAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      const result = await this.twitchAuth.api('/chat/messages', {
        method: 'POST',
        body: { broadcaster_id: this.broadcasterId, sender_id: this.twitchIdentity.user_id, message }
      });
      this.lastDebugMessageAt = Date.now();
      if (result.data?.[0]?.is_sent === false) throw new Error(result.data[0].drop_reason?.message || 'Twitch did not send the debug message.');
    }).catch(error => console.warn('[community-playlist] Could not send Twitch chat diagnostics.', error));
    return this.debugQueue;
  }

  async stop() {
    this.eventSub?.stop();
    this.redemptionProcessor.dispose();
    this.coordinator.stop();
    this.started = false;
    await this.releaseControllerLock();
    console.info('[community-playlist] Controller stopped. Spotify playback was not paused.');
  }

  async resume() {
    return this.coordinator.resume();
  }

  status() {
    return {
      running: this.started,
      channel: this.twitchIdentity?.login || null,
      powerUp: this.powerUp ? { id: this.powerUp.id, title: this.powerUp.title } : null,
      playlistUri: this.playlistUri,
      playback: this.coordinator.status()
    };
  }
}

function readProvisionedConfig() {
  let config = null;
  const match = location.hash.match(/^#cp=([A-Za-z0-9_-]+)$/);
  if (match) {
    const encoded = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    config = JSON.parse(new TextDecoder().decode(bytes));
    if (config.version !== 1 || config.provisioned !== true) throw new Error('Invalid OBS provisioning data.');
    history.replaceState({}, document.title, location.pathname + location.search);
    if (config.twitchToken) localStorage.setItem('community-playlist-twitch-token', JSON.stringify(config.twitchToken));
    if (config.spotifyToken) localStorage.setItem('community-playlist-spotify-token', JSON.stringify(config.spotifyToken));
    delete config.twitchToken;
    delete config.spotifyToken;
    localStorage.setItem('community-playlist-provisioned-config', JSON.stringify(config));
  }
  if (!config) {
    try { config = JSON.parse(localStorage.getItem('community-playlist-provisioned-config') || 'null'); }
    catch { config = null; }
  }
  return config;
}

async function bootstrap() {
  let config = readProvisionedConfig();
  if (!config) {
    try {
      const configModule = await import('../config.local.js');
      config = configModule.default || configModule;
    } catch {
      console.error('[community-playlist] No provisioned OBS configuration or config.local.js was found.');
      return;
    }
  }

  const app = new CommunityPlaylistApp(config);
  globalThis.communityPlaylist = {
    start: () => app.start().catch(error => {
      console.error('[community-playlist] Could not start:', error);
      throw error;
    }),
    stop: () => app.stop(),
    resume: () => app.resume(),
    status: () => app.status()
  };

  if (app.e2eMode) {
    const { createLiveE2ESuite } = await import('./e2e/live-suite.js');
    const suite = createLiveE2ESuite(app);
    globalThis.communityPlaylist.e2e = {
      preflight: () => suite.preflight(),
      preparePlayback: () => suite.preparePlayback(),
      cleanup: () => suite.restorePlaybackSettings(),
      runPlaybackSequence: () => suite.runPlaybackSequence(),
      runRealChatSkipTest: timeoutMs => suite.runRealChatSkipTest(timeoutMs),
      verifyProviderTokenRefresh: () => suite.verifyProviderTokenRefresh(),
      verifyEventSubReconnect: timeoutMs => suite.verifyEventSubReconnect(timeoutMs),
      waitForRealRedemption: timeoutMs => suite.waitForRealRedemption(timeoutMs)
    };
  }

  console.info('[community-playlist] Headless controller loaded.');
  if (config.autoStart || sessionStorage.getItem(app.autoStartKey) === '1') {
    sessionStorage.removeItem(app.autoStartKey);
    await app.start();
  }
}
bootstrap().catch(error => console.error('[community-playlist] Initialization failed:', error));
