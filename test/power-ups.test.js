import test from 'node:test';
import assert from 'node:assert/strict';
import { customPowerUpManagementUrl, findSelectableCustomPowerUp, isSelectableCustomPowerUp } from '../src/twitch/power-ups.js';

const usable = {
  id: 'power-up-1',
  title: 'Any title is valid',
  is_enabled: true,
  is_user_input_required: true,
  is_paused: false,
  is_in_stock: true
};

test('accepts an explicitly selected enabled text-input Custom Power-up by ID', () => {
  assert.equal(isSelectableCustomPowerUp(usable), true);
  assert.equal(findSelectableCustomPowerUp([usable], 'power-up-1'), usable);
});

test('does not use a title or choose a Power-up implicitly', () => {
  assert.equal(findSelectableCustomPowerUp([usable], ''), null);
  assert.equal(findSelectableCustomPowerUp([{ ...usable, id: 'other', title: usable.title }], 'power-up-1'), null);
});

test('rejects Power-ups that cannot accept song text input', () => {
  for (const patch of [
    { is_enabled: false },
    { is_user_input_required: false },
    { is_paused: true },
    { is_in_stock: false }
  ]) {
    const candidate = { ...usable, ...patch };
    assert.equal(isSelectableCustomPowerUp(candidate), false);
    assert.equal(findSelectableCustomPowerUp([candidate], usable.id), null);
  }
});

test('builds a direct Twitch Custom Power-ups dashboard URL for the authenticated broadcaster', () => {
  assert.equal(
    customPowerUpManagementUrl('streamer_name'),
    'https://dashboard.twitch.tv/u/streamer_name/viewer-rewards/channel-points/custom-rewards'
  );
  assert.equal(customPowerUpManagementUrl(''), null);
  assert.equal(
    customPowerUpManagementUrl('streamer name'),
    'https://dashboard.twitch.tv/u/streamer%20name/viewer-rewards/channel-points/custom-rewards'
  );
});
