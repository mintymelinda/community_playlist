import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, QueueStore } from '../src/lib/queue-store.js';
import { RedemptionProcessor } from '../src/twitch/redemption-processor.js';

const redemption = (id = 'redemption-1') => ({
  id,
  input: 'Track by Artist',
  requester: 'Viewer',
  requesterId: 'viewer-1'
});

const track = {
  uri: 'spotify:track:track-1',
  name: 'Track',
  artists: ['Artist'],
  durationMs: 180000
};

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.tasks = new Map();
  }
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delay });
    return id;
  }
  clearTimeout(id) {
    this.tasks.delete(id);
  }
  async run(id) {
    const task = this.tasks.get(id);
    assert.ok(task, 'expected retry timer to exist');
    this.tasks.delete(id);
    return task.callback();
  }
}

function createProcessor({ resolveTrack, enqueue, timers = new FakeTimers() } = {}) {
  const store = new QueueStore(new MemoryStorage());
  let resolutions = 0;
  const spotify = {
    async resolveTrack(input) {
      resolutions += 1;
      return resolveTrack ? resolveTrack(input, resolutions) : track;
    }
  };
  const coordinator = {
    async enqueue(request) {
      if (enqueue) return enqueue(request, store);
      store.enqueue(request);
    }
  };
  const logger = { info() {}, warn() {}, error() {} };
  const processor = new RedemptionProcessor({
    store, spotify, coordinator, timers, logger, retryBaseMs: 250, retryMaxMs: 2000
  });
  return { processor, store, timers, get resolutions() { return resolutions; } };
}

test('retries a transient Spotify lookup failure without losing the redemption', async () => {
  const env = createProcessor({
    resolveTrack: async (_input, attempt) => {
      if (attempt === 1) throw new TypeError('network offline');
      return track;
    }
  });

  assert.equal(await env.processor.accept(redemption()), false);
  let job = env.store.get().redemptionJobs[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
  assert.equal(env.store.get().pending.length, 0);
  const [timerId] = env.timers.tasks.keys();
  assert.equal(env.timers.tasks.get(timerId).delay, 250);

  await env.timers.run(timerId);
  job = env.store.get().redemptionJobs[0];
  assert.equal(job.status, 'queued');
  assert.equal(env.store.get().pending.length, 1);
  assert.equal(env.store.get().pending[0].id, 'redemption-1');
  assert.equal(env.resolutions, 2);
  assert.equal(env.timers.tasks.size, 0);
});

test('concurrent redeliveries resolve and enqueue only once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = createProcessor({
    resolveTrack: async () => {
      await gate;
      return track;
    }
  });

  const first = env.processor.accept(redemption());
  await Promise.resolve();
  assert.equal(await env.processor.accept(redemption()), false);
  release();
  assert.equal(await first, true);
  assert.equal(env.resolutions, 1);
  assert.equal(env.store.get().pending.length, 1);
});

test('recovers a crash after queue persistence without adding a duplicate', async () => {
  const env = createProcessor({
    enqueue: async (request, store) => {
      store.enqueue(request);
      throw new Error('Spotify playback confirmation failed');
    }
  });

  assert.equal(await env.processor.accept(redemption()), true);
  assert.equal(env.store.get().redemptionJobs[0].status, 'queued');
  assert.equal(env.store.get().pending.length, 1);
  assert.equal(await env.processor.accept(redemption()), false);
  assert.equal(env.store.get().pending.length, 1);
});

test('retries persisted pending redemptions after a new processor starts', async () => {
  const storage = new MemoryStorage();
  const firstStore = new QueueStore(storage);
  firstStore.recordRedemption(redemption('redemption-restart'));
  firstStore.claimRedemption('redemption-restart');

  const store = new QueueStore(storage);
  const timers = new FakeTimers();
  const processor = new RedemptionProcessor({
    store,
    spotify: { resolveTrack: async () => track },
    coordinator: { enqueue: async request => { store.enqueue(request); } },
    timers,
    logger: { info() {}, warn() {}, error() {} }
  });

  await processor.retryPending();
  assert.equal(store.get().redemptionJobs[0].status, 'queued');
  assert.equal(store.get().pending[0].id, 'redemption-restart');
});

test('marks empty and unresolvable input as terminal instead of retrying forever', async () => {
  const env = createProcessor({
    resolveTrack: async () => { throw new Error('Spotify could not find an available track for this query.'); }
  });

  await env.processor.accept({ ...redemption('empty'), input: ' ' });
  await env.processor.accept(redemption('unresolvable'));

  assert.deepEqual(
    env.store.get().redemptionJobs.map(job => job.status),
    ['ignored', 'ignored']
  );
  assert.equal(env.timers.tasks.size, 0);
});
