import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, QueueStore } from '../src/lib/queue-store.js';

test('persists FIFO requests across store instances', () => {
  const storage = new MemoryStorage();
  const first = new QueueStore(storage);
  first.enqueue({ id: 'one' });
  first.enqueue({ id: 'two' });
  const second = new QueueStore(storage);
  assert.deepEqual(second.get().pending.map(item => item.id), ['one', 'two']);
});

test('deduplicates redemptions and chat messages', () => {
  const store = new QueueStore(new MemoryStorage());
  assert.equal(store.rememberRedemption('redemption-1'), true);
  assert.equal(store.rememberRedemption('redemption-1'), false);
  assert.equal(store.rememberMessage('message-1'), true);
  assert.equal(store.rememberMessage('message-1'), false);
});

test('rejects requests beyond the configured queue limit', () => {
  const store = new QueueStore(new MemoryStorage(), 'queue', 1);
  assert.equal(store.enqueue({ id: 'one' }), true);
  assert.equal(store.enqueue({ id: 'two' }), false);
});

test('bounds deduplication history', () => {
  const store = new QueueStore(new MemoryStorage());
  for (let i = 0; i < 1005; i += 1) store.rememberRedemption('redemption-' + i);
  assert.equal(store.get().processedRedemptions.length, 1000);
  assert.equal(store.get().processedRedemptions.includes('redemption-0'), false);
});


test('recovers an interrupted redemption claim after a browser reload', () => {
  const storage = new MemoryStorage();
  const first = new QueueStore(storage);
  first.recordRedemption({ id: 'redemption-recovery', input: 'Song by Artist' });
  assert.equal(first.claimRedemption('redemption-recovery').status, 'processing');

  const reloaded = new QueueStore(storage);
  const job = reloaded.getRetryableRedemptions()[0];
  assert.equal(job.id, 'redemption-recovery');
  assert.equal(job.status, 'pending');
  assert.match(job.lastError, /interrupted redemption/);
  assert.equal(reloaded.claimRedemption(job.id).attempts, 2);
});

test('makes redemption completion terminal and idempotent', () => {
  const store = new QueueStore(new MemoryStorage());
  store.recordRedemption({ id: 'redemption-once', input: 'Song' });
  store.claimRedemption('redemption-once');
  store.finishRedemption('redemption-once', 'queued');

  assert.equal(store.recordRedemption({ id: 'redemption-once', input: 'Song' }), false);
  assert.equal(store.claimRedemption('redemption-once'), null);
  assert.deepEqual(store.get().processedRedemptions, ['redemption-once']);
});

test('does not enqueue the same request ID twice', () => {
  const store = new QueueStore(new MemoryStorage());
  assert.equal(store.enqueue({ id: 'request-once' }), true);
  assert.equal(store.enqueue({ id: 'request-once' }), false);
  assert.deepEqual(store.get().pending.map(item => item.id), ['request-once']);
});
