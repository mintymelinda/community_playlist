import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchEventSub } from '../src/twitch/eventsub.js';

const broadcasterId = 'broadcaster-1';
const powerUpId = 'power-up-1';

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
  }
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delay });
    return id;
  }
  clearTimeout(id) {
    this.timeouts.delete(id);
  }
  setInterval(callback, delay) {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  }
  clearInterval(id) {
    this.intervals.delete(id);
  }
  fireTimeout(id) {
    const task = this.timeouts.get(id);
    assert.ok(task, 'expected timeout to exist');
    this.timeouts.delete(id);
    return task.callback();
  }
  fireIntervals() {
    for (const task of this.intervals.values()) task.callback();
  }
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closeCalls = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  message(message) {
    this.emit('message', { data: JSON.stringify(message) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close', {});
  }
}

function welcome(sessionId) {
  return {
    metadata: { message_type: 'session_welcome' },
    payload: {
      session: {
        id: sessionId,
        keepalive_timeout_seconds: 10
      }
    }
  };
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

function createEventSub() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  const subscriptions = [];
  const redemptions = [];
  const commands = [];
  const log = { info() {}, warn() {}, error() {} };
  const store = {
    messages: new Set(),
    rememberMessage(id) {
      if (this.messages.has(id)) return false;
      this.messages.add(id);
      return true;
    }
  };
  const twitchAuth = {
    async api(path, options) {
      if (path === '/eventsub/subscriptions') subscriptions.push(options.body);
      return {};
    }
  };
  const eventSub = new TwitchEventSub({
    twitchAuth,
    broadcasterId,
    powerUpId,
    onRedemption: async value => redemptions.push(value),
    onChatCommand: async value => commands.push(value),
    store,
    logger: log,
    WebSocketImpl: FakeWebSocket,
    timers
  });
  return { eventSub, timers, subscriptions, redemptions, commands };
}

async function connect(eventSub, sessionId = 'session-1') {
  const connecting = eventSub.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message(welcome(sessionId));
  await connecting;
  return socket;
}

test('opens EventSub and subscribes to redemption and broadcaster chat events', async () => {
  const env = createEventSub();
  const socket = await connect(env.eventSub);

  assert.equal(env.eventSub.socket, socket);
  assert.equal(env.eventSub.sessionId, 'session-1');
  assert.equal(env.eventSub.subscribedSessionId, 'session-1');
  assert.deepEqual(env.subscriptions.map(item => item.type), [
    'channel.custom_power_up_redemption.add',
    'channel.chat.message'
  ]);
  assert.deepEqual(env.subscriptions.map(item => item.transport.session_id), [
    'session-1',
    'session-1'
  ]);
  assert.deepEqual(env.subscriptions.map(item => item.condition), [
    { broadcaster_user_id: broadcasterId, reward_id: powerUpId },
    { broadcaster_user_id: broadcasterId, user_id: broadcasterId }
  ]);

  await env.eventSub.handleNotification({
    metadata: { message_type: 'notification', message_id: 'event-1' },
    payload: {
      subscription: { type: 'channel.custom_power_up_redemption.add' },
      event: {
        id: 'redemption-1',
        broadcaster_user_id: broadcasterId,
        user_id: 'viewer-1',
        user_name: 'Viewer',
        user_input: 'Song by Artist',
        custom_power_up: { id: powerUpId },
        status: 'fulfilled'
      }
    }
  });

  assert.equal(env.redemptions.length, 1);
  assert.equal(env.redemptions[0].id, 'redemption-1');
  env.eventSub.stop();
});

test('migrates to Twitch reconnect URL without duplicating subscriptions', async () => {
  const env = createEventSub();
  const oldSocket = await connect(env.eventSub);
  oldSocket.message({
    metadata: { message_type: 'session_reconnect' },
    payload: { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } }
  });

  const migratedSocket = FakeWebSocket.instances.at(-1);
  assert.notEqual(migratedSocket, oldSocket);
  assert.match(migratedSocket.url, /reconnect=1/);
  migratedSocket.message(welcome('session-2'));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.eventSub.socket, migratedSocket);
  assert.equal(env.eventSub.sessionId, 'session-2');
  assert.equal(env.eventSub.subscribedSessionId, 'session-2');
  assert.equal(oldSocket.readyState, 3);
  assert.equal(env.subscriptions.length, 2);
  env.eventSub.stop();
});

test('reconnects after an unexpected socket close and re-subscribes', async () => {
  const env = createEventSub();
  const firstSocket = await connect(env.eventSub);
  firstSocket.close(1006, 'network loss');

  const [timerId] = env.timers.timeouts.keys();
  assert.equal(env.timers.timeouts.get(timerId).delay, 2000);
  const reconnecting = env.timers.fireTimeout(timerId);
  const secondSocket = FakeWebSocket.instances.at(-1);
  secondSocket.message(welcome('session-2'));
  await reconnecting;

  assert.equal(env.eventSub.socket, secondSocket);
  assert.equal(env.eventSub.sessionId, 'session-2');
  assert.equal(env.eventSub.subscribedSessionId, 'session-2');
  assert.equal(env.subscriptions.length, 4);
  env.eventSub.stop();
});

test('closes a stale keepalive session and schedules reconnect', async () => {
  const env = createEventSub();
  const socket = await connect(env.eventSub);
  env.eventSub.lastMessageAt = Date.now() - 20000;

  env.timers.fireIntervals();

  assert.equal(socket.readyState, 3);
  assert.equal(env.timers.timeouts.size, 1);
  env.eventSub.stop();
  assert.equal(env.timers.timeouts.size, 0);
  assert.equal(env.timers.intervals.size, 0);
});

test('stop closes active sockets and cancels reconnect and keepalive timers', async () => {
  const env = createEventSub();
  const socket = await connect(env.eventSub);
  socket.close(1006, 'network loss');
  assert.equal(env.timers.timeouts.size, 1);

  env.eventSub.stop();

  assert.equal(socket.readyState, 3);
  assert.equal(env.timers.timeouts.size, 0);
  assert.equal(env.timers.intervals.size, 0);
  assert.equal(env.eventSub.socket, null);
});


test('ignores unauthorized real chat messages and deduplicates authorized !skip events', async () => {
  const env = createEventSub();
  const unauthorized = chatNotification(
    broadcasterId,
    'ordinary-viewer',
    'unauthorized-skip'
  );
  await env.eventSub.handleNotification(unauthorized);

  assert.equal(env.commands.length, 0);
  assert.equal(env.eventSub.store.messages.has('unauthorized-skip'), false);

  const broadcaster = chatNotification(broadcasterId, broadcasterId, 'broadcaster-skip');
  await env.eventSub.handleNotification(broadcaster);
  assert.equal(env.commands.length, 1);
  assert.equal(env.commands[0].command, 'skip');

  const authorized = chatNotification(
    broadcasterId,
    'moderator-1',
    'authorized-skip',
    [{ set_id: 'moderator', id: '1' }]
  );
  await env.eventSub.handleNotification(authorized);
  await env.eventSub.handleNotification(authorized);

  assert.equal(env.commands.length, 2);
  assert.equal(env.commands[1].command, 'skip');
  assert.equal(env.eventSub.store.messages.has('authorized-skip'), true);
});
