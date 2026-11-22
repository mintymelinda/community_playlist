import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedSkip, isSkipCommand, normalizeCustomPowerUpRedemption } from '../src/twitch/eventsub.js';

const broadcasterId = 'broadcaster-1';

test('recognizes a Twitch Custom Power-up redemption and keeps submitted input', () => {
  assert.deepEqual(normalizeCustomPowerUpRedemption({
    id: 'redemption-1',
    broadcaster_user_id: broadcasterId,
    user_id: 'viewer-1',
    user_name: 'Viewer',
    user_input: 'Song by Artist',
    status: 'fulfilled',
    custom_power_up: { id: 'power-up-1' }
  }, broadcasterId, 'power-up-1'), {
    id: 'redemption-1',
    input: 'Song by Artist',
    requester: 'Viewer',
    requesterId: 'viewer-1'
  });
});

test('ignores unrelated and canceled Power-up notifications', () => {
  assert.equal(normalizeCustomPowerUpRedemption({
    id: 'wrong', broadcaster_user_id: broadcasterId, custom_power_up: { id: 'other' }
  }, broadcasterId, 'power-up-1'), null);
  assert.equal(normalizeCustomPowerUpRedemption({
    id: 'canceled', broadcaster_user_id: broadcasterId, status: 'canceled', custom_power_up: { id: 'power-up-1' }
  }, broadcasterId, 'power-up-1'), null);
});

test('accepts skip from the broadcaster and moderator badge only', () => {
  assert.equal(isAuthorizedSkip({ broadcaster_user_id: broadcasterId, chatter_user_id: broadcasterId }, broadcasterId), true);
  assert.equal(isAuthorizedSkip({
    broadcaster_user_id: broadcasterId,
    chatter_user_id: 'mod-1',
    badges: [{ set_id: 'moderator', id: '1' }]
  }, broadcasterId), true);
  assert.equal(isAuthorizedSkip({
    broadcaster_user_id: broadcasterId,
    chatter_user_id: 'viewer-1',
    badges: [{ set_id: 'subscriber', id: '1' }]
  }, broadcasterId), false);
});

test('matches only the exact !skip command', () => {
  assert.equal(isSkipCommand({ message: { text: '!skip' } }), true);
  assert.equal(isSkipCommand({ message: { text: '!SKIP' } }), true);
  assert.equal(isSkipCommand({ message: { text: '!skip this' } }), false);
});
