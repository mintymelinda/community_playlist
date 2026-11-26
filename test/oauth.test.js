import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/lib/queue-store.js';
import { TokenStore } from '../src/lib/token-store.js';
import { TwitchAuth } from '../src/auth/twitch-auth.js';
import { SpotifyAuth } from '../src/auth/spotify-auth.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('Twitch Device Code flow polls pending authorization then validates the broadcaster token', async () => {
  const tokenStore = new TokenStore(new MemoryStorage(), 'twitch');
  const urls = [];
  let tokenPolls = 0;
  let codeInfo = null;
  const fetchImpl = async (url, options = {}) => {
    urls.push(url);
    if (url.endsWith('/device')) {
      return jsonResponse({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://www.twitch.tv/activate',
        expires_in: 60,
        interval: 1
      });
    }
    if (url.endsWith('/token')) {
      tokenPolls += 1;
      if (tokenPolls === 1) return jsonResponse({ status: 400, message: 'authorization_pending' }, 400);
      return jsonResponse({
        access_token: 'access',
        refresh_token: 'refresh-1',
        expires_in: 14400,
        scope: ['bits:read', 'user:read:chat']
      });
    }
    if (url.endsWith('/validate')) {
      return jsonResponse({
        client_id: 'twitch-client',
        user_id: 'broadcaster-1',
        scopes: ['bits:read', 'user:read:chat']
      });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const auth = new TwitchAuth({
    clientId: 'twitch-client',
    scopes: ['bits:read', 'user:read:chat'],
    tokenStore,
    fetchImpl,
    sleep: async () => {},
    onDeviceCode: info => { codeInfo = info; }
  });

  const session = await auth.authorize();
  assert.equal(session.accessToken, 'access');
  assert.equal(session.refreshToken, 'refresh-1');
  assert.equal(auth.identity.user_id, 'broadcaster-1');
  assert.equal(tokenPolls, 2);
  assert.equal(codeInfo.userCode, 'ABCD-EFGH');
  assert.equal(urls.some(url => url.endsWith('/validate')), true);
});

test('TwitchAuth binds the browser default fetch receiver when validating a token', async () => {
  const tokenStore = new TokenStore(new MemoryStorage(), 'twitch-default-fetch');
  tokenStore.save({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000,
    scopes: ['bits:read', 'user:read:chat']
  });

  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async function (url, options = {}) {
    assert.equal(this, globalThis, 'default fetch must be invoked with the global receiver');
    assert.equal(url, 'https://id.twitch.tv/oauth2/validate');
    assert.equal(options.headers.Authorization, 'OAuth access');
    called = true;
    return jsonResponse({
      client_id: 'twitch-client',
      user_id: 'broadcaster-1',
      scopes: ['bits:read', 'user:read:chat']
    });
  };

  try {
    const auth = new TwitchAuth({
      clientId: 'twitch-client',
      scopes: ['bits:read', 'user:read:chat'],
      tokenStore
    });
    const identity = await auth.validate();
    assert.equal(called, true);
    assert.equal(identity.user_id, 'broadcaster-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Twitch refresh stores the rotated single-use refresh token', async () => {
  const tokenStore = new TokenStore(new MemoryStorage(), 'twitch');
  tokenStore.save({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1000,
    scopes: ['bits:read']
  });
  let submitted;
  const auth = new TwitchAuth({
    clientId: 'twitch-client',
    scopes: ['bits:read'],
    tokenStore,
    fetchImpl: async (url, options) => {
      submitted = new URLSearchParams(options.body);
      return jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 14400,
        scope: ['bits:read']
      });
    }
  });

  assert.equal(await auth.getAccessToken(), 'new-access');
  assert.equal(submitted.get('refresh_token'), 'old-refresh');
  assert.equal(tokenStore.load().refreshToken, 'new-refresh');
});

test('Spotify PKCE authorization stores verifier/state and redirects with S256', async () => {
  const tokenStore = new TokenStore(new MemoryStorage(), 'spotify');
  const pkceStore = new TokenStore(new MemoryStorage(), 'pkce');
  let redirectedTo = '';
  const auth = new SpotifyAuth({
    clientId: 'spotify-client',
    redirectUri: 'https://example.test/controller/',
    scopes: ['user-read-playback-state'],
    tokenStore,
    pkceStore,
    locationRef: {
      href: 'https://example.test/controller/',
      pathname: '/controller/',
      assign(url) { redirectedTo = url; }
    },
    historyRef: { replaceState() {} }
  });

  await auth.beginAuthorization();
  const url = new URL(redirectedTo);
  const pending = pkceStore.load();
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), pending.state);
  assert.equal(pending.verifier.length > 40, true);
  assert.equal(url.searchParams.get('code_challenge').length, 43);
});

test('Spotify refresh accepts token rotation and preserves the new refresh token', async () => {
  const tokenStore = new TokenStore(new MemoryStorage(), 'spotify');
  tokenStore.save({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1000,
    scopes: []
  });
  let submitted;
  const auth = new SpotifyAuth({
    clientId: 'spotify-client',
    redirectUri: 'https://example.test/controller/',
    scopes: ['user-read-playback-state'],
    tokenStore,
    fetchImpl: async (url, options) => {
      submitted = new URLSearchParams(options.body);
      return jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user-read-playback-state'
      });
    },
    locationRef: { href: 'https://example.test/controller/', pathname: '/controller/' },
    historyRef: { replaceState() {} }
  });

  assert.equal(await auth.getAccessToken(), 'new-access');
  assert.equal(submitted.get('refresh_token'), 'old-refresh');
  assert.equal(tokenStore.load().refreshToken, 'new-refresh');
});
