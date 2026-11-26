import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptOAuthVault, encryptOAuthVault } from '../scripts/e2e/oauth-vault.js';

const key = randomBytes(32).toString('base64');
const vault = {
  version: 1,
  updatedAt: 123456,
  spotify: {
    refreshToken: 'spotify-refresh-token-secret',
    scopes: ['user-read-playback-state', 'user-modify-playback-state']
  },
  twitch: {
    refreshToken: 'twitch-refresh-token-secret',
    scopes: ['bits:read', 'user:read:chat'],
    userId: '123456'
  }
};

test('encrypts both providers refresh tokens and restores the vault', () => {
  const encrypted = encryptOAuthVault(vault, key);
  assert.equal(JSON.stringify(encrypted).includes(vault.spotify.refreshToken), false);
  assert.equal(JSON.stringify(encrypted).includes(vault.twitch.refreshToken), false);
  assert.deepEqual(decryptOAuthVault(encrypted, key), vault);
});

test('rejects a vault encrypted with another key', () => {
  const encrypted = encryptOAuthVault(vault, key);
  assert.throws(
    () => decryptOAuthVault(encrypted, randomBytes(32).toString('base64')),
    /Could not decrypt the OAuth vault/
  );
});

test('rejects modified ciphertext and malformed provider credentials', () => {
  const encrypted = encryptOAuthVault(vault, key);
  const tampered = { ...encrypted, data: Buffer.from('tampered').toString('base64') };
  assert.throws(() => decryptOAuthVault(tampered, key), /Could not decrypt the OAuth vault/);

  assert.throws(() => encryptOAuthVault({
    ...vault,
    twitch: { scopes: ['bits:read'] }
  }, key), /missing the Twitch refresh token/);
});
