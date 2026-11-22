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
  for (const key of ['twitchClientId', 'spotifyClientId', 'spotifyRedirectUri', 'playlistUri']) {
    if (!config[key] || String(config[key]).includes('YOUR_')) {
      throw new Error('Set ' + key + ' in config.local.js before starting the controller.');
    }
  }
  const redirect = new URL(config.spotifyRedirectUri);
  if (redirect.origin !== location.origin || redirect.pathname !== location.pathname || redirect.search || redirect.hash) {
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
    if (this.e2eMode && sessionStorage.getItem('community-playlist-e2e-initialized') !== '1') {
      localStorage.removeItem(queueKey);
      sessionStorage.setItem('community-playlist-e2e-initialized', '1');
    }
    this.store = new QueueStore(localStorage, queueKey, config.maxPendingRequests || 100);
    this.twitchAuth = new TwitchAuth({
      clientId: config.twitchClientId,
      scopes: ['bits:read', 'user:read:chat'],
      tokenStore: new TokenStore(sessionStorage, storagePrefix + 'twitch-token')
    });
    const spotifyTokenStore = new TokenStore(sessionStorage, storagePrefix + 'spotify-token');
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
    this.coordinator = new PlaybackCoordinator({
      spotify: this.spotify,
      store: this.store,
      playlistUri: config.playlistUri,
      playlistId: this.spotify.extractPlaylistId(config.playlistUri),
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
    this.broadcasterId = null;
    this.powerUp = null;
  }

  async start() {
    if (this.started) return this.status();
    validateConfig(this.config);

    await this.spotifyAuth.handleRedirect();
    if (!this.spotifyAuth.session?.accessToken) {
      sessionStorage.setItem(this.autoStartKey, '1');
      await this.spotifyAuth.beginAuthorization();
      return { mode: 'spotify-authorization' };
    }

    const twitchIdentity = await this.twitchAuth.validate();
    this.broadcasterId = this.config.broadcasterId || twitchIdentity.user_id;
    if (String(this.broadcasterId) !== String(twitchIdentity.user_id)) {
      throw new Error('Twitch must be authorized by the broadcaster account configured for this channel.');
    }

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
      onChatCommand: command => this.handleChatCommand(command)
    });

    try {
      await this.eventSub.connect();
    } catch (error) {
      this.eventSub.stop();
      this.coordinator.stop();
      throw error;
    }

    this.started = true;
    console.info('[community-playlist] Controller is running. Power-up: ' + powerUp.title + '. Playlist: ' + this.config.playlistUri);
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
    if (command.command === 'skip') {
      const skipped = await this.coordinator.skip();
      if (skipped) console.info('[community-playlist] Moderator skip accepted.');
    }
  }

  async stop() {
    this.eventSub?.stop();
    this.redemptionProcessor.dispose();
    this.coordinator.stop();
    this.started = false;
    console.info('[community-playlist] Controller stopped. Spotify playback was not paused.');
  }

  async resume() {
    return this.coordinator.resume();
  }

  status() {
    return {
      running: this.started,
      broadcasterId: this.broadcasterId,
      powerUp: this.powerUp ? { id: this.powerUp.id, title: this.powerUp.title } : null,
      playlistUri: this.config.playlistUri,
      playback: this.coordinator.status()
    };
  }
}

async function bootstrap() {
  let configModule;
  try {
    configModule = await import('../config.local.js');
  } catch {
    console.error('[community-playlist] Missing config.local.js. Copy config.example.js to config.local.js and configure the client IDs and playlist URI.');
    return;
  }

  const app = new CommunityPlaylistApp(configModule.default || configModule);
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
      runPlaybackSequence: () => suite.runPlaybackSequence(),
      waitForRealRedemption: timeoutMs => suite.waitForRealRedemption(timeoutMs)
    };
  }

  console.info('[community-playlist] Headless controller loaded. Run communityPlaylist.start() in the console.');
  if (sessionStorage.getItem(app.autoStartKey) === '1') {
    sessionStorage.removeItem(app.autoStartKey);
    await app.start();
  }
}

bootstrap().catch(error => console.error('[community-playlist] Initialization failed:', error));
