const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const EVENTSUB_API = '/eventsub/subscriptions';

export function normalizeCustomPowerUpRedemption(event, broadcasterId, powerUpId) {
  if (!event || event.broadcaster_user_id !== broadcasterId) return null;
  if (event.custom_power_up?.id !== powerUpId || event.status === 'canceled') return null;
  return {
    id: event.id,
    input: event.user_input || '',
    requester: event.user_name || event.user_login || 'Viewer',
    requesterId: event.user_id
  };
}

export function isAuthorizedSkip(event, broadcasterId) {
  if (!event || event.broadcaster_user_id !== broadcasterId) return false;
  if (event.chatter_user_id === broadcasterId) return true;
  return (event.badges || []).some(badge =>
    badge.set_id === 'moderator' || badge.set_id === 'broadcaster'
  );
}

export function isSkipCommand(event) {
  return String(event?.message?.text || '').trim().toLowerCase() === '!skip';
}

export class TwitchEventSub {
  constructor({ twitchAuth, broadcasterId, powerUpId, onRedemption, onChatCommand, store, logger = console, WebSocketImpl = WebSocket, timers = globalThis }) {
    this.auth = twitchAuth;
    this.broadcasterId = broadcasterId;
    this.powerUpId = powerUpId;
    this.onRedemption = onRedemption;
    this.onChatCommand = onChatCommand;
    this.store = store;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.socket = null;
    this.oldSocket = null;
    this.sessionId = null;
    this.subscribedSessionId = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.reconnectAttempts = 0;
    this.lastMessageAt = 0;
  }

  async discoverPowerUp(configuredId) {
    const params = new URLSearchParams({ broadcaster_id: this.broadcasterId });
    const response = await this.auth.api('/bits/custom_power_ups?' + params.toString());
    const eligible = (response.data || []).filter(item =>
      item.is_enabled &&
      item.is_user_input_required &&
      !item.is_paused &&
      item.is_in_stock
    );

    const selected = configuredId
      ? eligible.find(item => item.id === configuredId)
      : eligible.length === 1 ? eligible[0] : null;

    if (!selected) {
      if (configuredId) throw new Error('Configured Twitch Power-up is not enabled, available, and configured for text input.');
      if (!eligible.length) throw new Error('No enabled, available Custom Power-up requiring viewer text input was found.');
      throw new Error('More than one eligible Custom Power-up exists. Set powerUpId in config.local.js.');
    }
    return selected;
  }

  async connect() {
    this.stopped = false;
    this.reconnectAttempts = 0;
    return this.openSocket(EVENTSUB_URL, false);
  }

  async openSocket(url, migrating) {
    if (this.stopped) return;
    const socket = new this.WebSocketImpl(url);
    const oldSocket = this.socket;
    let welcomeResolve;
    let welcomeReject;
    const welcomed = new Promise((resolve, reject) => {
      welcomeResolve = resolve;
      welcomeReject = reject;
    });
    const timeout = this.timers.setTimeout(() => welcomeReject(new Error('Timed out waiting for Twitch EventSub welcome.')), 15000);

    socket.addEventListener('open', () => {
      this.logger.info('[community-playlist] Twitch EventSub WebSocket connected.');
    });

    socket.addEventListener('message', event => {
      this.lastMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.logger.warn('[community-playlist] Ignored invalid EventSub JSON message.');
        return;
      }

      const type = message.metadata?.message_type;
      if (type === 'session_welcome') {
        this.timers.clearTimeout(timeout);
        const sessionId = message.payload?.session?.id;
        if (!sessionId) {
          welcomeReject(new Error('Twitch EventSub welcome did not include a session ID.'));
          return;
        }
        this.socket = socket;
        this.sessionId = sessionId;
        if (oldSocket && oldSocket !== socket && oldSocket.readyState < 2) {
          oldSocket.close(1000, migrating ? 'Session migrated' : 'Replaced after reconnect');
        }
        if (migrating) {
          this.oldSocket = null;
          this.logger.info('[community-playlist] Twitch EventSub session migrated.');
        } else {
          this.reconnectAttempts = 0;
        }
        const timeoutSeconds = Number(message.payload?.session?.keepalive_timeout_seconds) || 10;
        this.startKeepaliveWatch(timeoutSeconds);
        welcomeResolve(sessionId);
        return;
      }

      if (type === 'session_reconnect') {
        const reconnectUrl = message.payload?.session?.reconnect_url;
        if (reconnectUrl) {
          this.oldSocket = socket;
          this.openSocket(reconnectUrl, true).catch(error => {
            this.logger.warn('[community-playlist] EventSub migration failed.', error);
            this.scheduleReconnect();
          });
        }
        return;
      }

      if (type === 'revocation') {
        this.logger.error('[community-playlist] Twitch revoked an EventSub subscription:', message.payload?.subscription?.status);
        return;
      }

      if (type === 'notification') {
        this.handleNotification(message).catch(error => this.logger.error('[community-playlist] EventSub handler failed.', error));
      }
    });

    socket.addEventListener('close', () => {
      this.timers.clearTimeout(timeout);
      if (socket === this.socket) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      welcomeReject(new Error('Twitch EventSub WebSocket connection failed.'));
    });

    try {
      const sessionId = await welcomed;
      this.timers.clearTimeout(timeout);
      if (!migrating) {
        try {
          await this.subscribe(sessionId);
        } catch (error) {
          socket.close();
          throw error;
        }
      }
      return sessionId;
    } catch (error) {
      this.timers.clearTimeout(timeout);
      if (socket.readyState < 2) socket.close();
      throw error;
    }
  }

  startKeepaliveWatch(timeoutSeconds) {
    this.timers.clearInterval(this.keepaliveTimer);
    this.lastMessageAt = Date.now();
    this.keepaliveTimer = this.timers.setInterval(() => {
      if (this.stopped || !this.socket) return;
      if (Date.now() - this.lastMessageAt > timeoutSeconds * 1000 + 1000) {
        this.logger.warn('[community-playlist] Twitch EventSub keepalive timed out.');
        this.socket.close();
      }
    }, Math.max(2000, timeoutSeconds * 500));
  }

  async subscribe(sessionId) {
    const common = { broadcaster_user_id: this.broadcasterId };
    const subscriptions = [
      {
        type: 'channel.custom_power_up_redemption.add',
        version: '1',
        condition: { ...common, reward_id: this.powerUpId }
      },
      {
        type: 'channel.chat.message',
        version: '1',
        condition: { ...common, user_id: this.broadcasterId }
      }
    ];

    for (const subscription of subscriptions) {
      await this.auth.api(EVENTSUB_API, {
        method: 'POST',
        body: {
          ...subscription,
          transport: { method: 'websocket', session_id: sessionId }
        }
      });
    }
    this.logger.info('[community-playlist] Twitch redemption and chat subscriptions enabled.');
  }

  async handleNotification(message) {
    const event = message.payload?.event;
    const type = message.payload?.subscription?.type;
    const messageId = message.metadata?.message_id;
    if (type === 'channel.custom_power_up_redemption.add') {
      const redemption = normalizeCustomPowerUpRedemption(event, this.broadcasterId, this.powerUpId);
      if (!redemption || !redemption.id) return;
      await this.onRedemption(redemption);
      return;
    }

    if (type === 'channel.chat.message') {
      if (!isSkipCommand(event) || !isAuthorizedSkip(event, this.broadcasterId)) return;
      if (!this.store.rememberMessage(messageId || event.message_id)) return;
      await this.onChatCommand({ command: 'skip', user: event.chatter_user_name || event.chatter_user_login });
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.timers.clearInterval(this.keepaliveTimer);
    this.reconnectAttempts += 1;
    const wait = Math.min(30000, 1000 * (2 ** Math.min(this.reconnectAttempts, 5)));
    this.logger.warn('[community-playlist] Reconnecting Twitch EventSub in ' + wait + 'ms.');
    this.reconnectTimer = this.timers.setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.openSocket(EVENTSUB_URL, false);
      } catch (error) {
        this.logger.warn('[community-playlist] Twitch EventSub reconnect failed.', error);
        this.scheduleReconnect();
      }
    }, wait);
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.reconnectTimer);
    this.timers.clearInterval(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    if (this.socket && this.socket.readyState < 2) this.socket.close(1000, 'Controller stopped');
    if (this.oldSocket && this.oldSocket.readyState < 2) this.oldSocket.close(1000, 'Controller stopped');
    this.socket = null;
    this.oldSocket = null;
    this.sessionId = null;
    this.subscribedSessionId = null;
  }
}
