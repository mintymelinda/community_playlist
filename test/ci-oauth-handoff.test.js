import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createSpotifyPkceHandoff,
  decryptSpotifyPkceHandoff,
  encryptSpotifyPkceHandoff,
  parseSpotifyCallbackUrl,
  SPOTIFY_SCOPES
} from '../scripts/e2e/spotify-pkce-handoff.js';

const key = randomBytes(32).toString('base64');

test('Spotify CI PKCE handoff encrypts verifier and validates the callback state', () => {
  const { payload, authorizationUrl } = createSpotifyPkceHandoff({
    clientId: 'spotify-public-client',
    now: 1000
  });
  const authorization = new URL(authorizationUrl);
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('client_id'), 'spotify-public-client');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), SPOTIFY_SCOPES.join(' '));
  assert.equal(authorization.searchParams.get('state'), payload.state);
  assert.equal(authorization.searchParams.has('code_verifier'), false);

  const encrypted = encryptSpotifyPkceHandoff(payload, key);
  assert.equal(JSON.stringify(encrypted).includes(payload.verifier), false);
  const restored = decryptSpotifyPkceHandoff(encrypted, key, 2000);
  assert.deepEqual(restored, payload);

  const callback = parseSpotifyCallbackUrl(
    'http://127.0.0.1:4173/?code=one-time-code&state=' + payload.state,
    restored
  );
  assert.deepEqual(callback, { code: 'one-time-code', state: payload.state });
});

test('distinguishes a redirect-only URL from a complete Spotify callback URL', () => {
  const { payload } = createSpotifyPkceHandoff({
    clientId: 'spotify-public-client'
  });
  assert.throws(
    () => parseSpotifyCallbackUrl('http://127.0.0.1:4173/', payload),
    /has no authorization code.*do not enter only/
  );
  assert.throws(
    () => parseSpotifyCallbackUrl('http://127.0.0.1:4173/?code=one-time-code', payload),
    /has no state parameter/
  );
  assert.throws(
    () => parseSpotifyCallbackUrl('http://127.0.0.1:4173/?code=one-time-code&state=wrong', payload),
    /does not match the PKCE handoff/
  );
});

test('rejects a Spotify Soloist key where the OAuth Client ID is required', () => {
  assert.throws(() => createSpotifyPkceHandoff({
    clientId: 'spak_device_pairing_key'
  }), /sensitive Spotify Soloist API key/);
});

test('Spotify CI PKCE handoff rejects a wrong key, callback state, and expired handoff', () => {
  const { payload } = createSpotifyPkceHandoff({
    clientId: 'spotify-public-client',
    now: 1000
  });
  const encrypted = encryptSpotifyPkceHandoff(payload, key);
  assert.throws(() => decryptSpotifyPkceHandoff(encrypted, randomBytes(32).toString('base64'), 2000), /Could not decrypt/);
  assert.throws(() => decryptSpotifyPkceHandoff(encrypted, key, 1000 + 24 * 60 * 60 * 1000 + 1), /expired/);

  assert.throws(() => parseSpotifyCallbackUrl(
    'http://127.0.0.1:4173/?code=one-time-code&state=wrong-state',
    payload
  ), /invalid state/);
  assert.throws(() => parseSpotifyCallbackUrl(
    'http://127.0.0.1:4174/?code=one-time-code&state=' + payload.state,
    payload
  ), /does not match/);
});

test('Spotify PKCE handoff refuses redirect URIs outside its fixed loopback callback', () => {
  assert.throws(() => createSpotifyPkceHandoff({
    clientId: 'spotify-public-client',
    redirectUri: 'https://example.test/callback'
  }), /CI redirect URI/);
});
