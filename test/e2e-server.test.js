import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, buildConfig } from '../scripts/e2e/server.js';

const validEnv = {
  PORT: '4173',
  TWITCH_CLIENT_ID: 'twitch-public-client-id',
  SPOTIFY_CLIENT_ID: 'spotify-public-client-id',
  SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:4173/',
  SPOTIFY_PLAYLIST_URI: 'spotify:playlist:playlist123',
  E2E_TRACK_X: 'spotify:track:trackX',
  E2E_TRACK_Y: 'spotify:track:trackY'
};

test('builds an allowlisted E2E config and ignores pasted secrets and tokens', () => {
  const config = buildConfig({
    ...validEnv,
    TWITCH_CLIENT_SECRET: 'must-not-be-used',
    SPOTIFY_CLIENT_SECRET: 'must-not-be-used',
    TWITCH_ACCESS_TOKEN: 'must-not-be-used',
    SPOTIFY_REFRESH_TOKEN: 'must-not-be-used'
  });

  assert.deepEqual(Object.keys(config).sort(), [
    'broadcasterId',
    'e2eMode',
    'e2eTrackX',
    'e2eTrackY',
    'maxPendingRequests',
    'playlistUri',
    'pollIntervalMs',
    'powerUpId',
    'spotifyClientId',
    'spotifyDeviceId',
    'spotifyRedirectUri',
    'twitchClientId'
  ].sort());
  assert.equal(config.twitchClientId, validEnv.TWITCH_CLIENT_ID);
  assert.equal(config.spotifyClientId, validEnv.SPOTIFY_CLIENT_ID);
  assert.equal(config.e2eMode, true);
  assert.equal(JSON.stringify(config).includes('must-not-be-used'), false);
});

test('normalizes the supplied bare Spotify IDs and retains the configured broadcaster ID', () => {
  const config = buildConfig({
    ...validEnv,
    SPOTIFY_PLAYLIST_URI: '7IS0sJMyOz3XAhqRxkOwkC',
    E2E_TRACK_X: '4EISOJDYezvr8UtIeOy3sj',
    E2E_TRACK_Y: '5l8xjpKJW5Yj7mSSlSth3K',
    TWITCH_BROADCASTER_ID: '56809801'
  });

  assert.equal(config.playlistUri, 'spotify:playlist:7IS0sJMyOz3XAhqRxkOwkC');
  assert.equal(config.e2eTrackX, 'spotify:track:4EISOJDYezvr8UtIeOy3sj');
  assert.equal(config.e2eTrackY, 'spotify:track:5l8xjpKJW5Yj7mSSlSth3K');
  assert.equal(config.broadcasterId, '56809801');
});

test('rejects text search phrases in deterministic live E2E track settings', () => {
  assert.throws(() => buildConfig({
    ...validEnv,
    E2E_TRACK_X: 'Song title and artist'
  }), /must be a Spotify track ID, URI, or URL/);
});

test('requires both public client IDs, a playlist, and two distinct test tracks', () => {
  for (const key of [
    'TWITCH_CLIENT_ID',
    'SPOTIFY_CLIENT_ID',
    'SPOTIFY_PLAYLIST_URI',
    'E2E_TRACK_X',
    'E2E_TRACK_Y'
  ]) {
    const env = { ...validEnv };
    delete env[key];
    assert.throws(() => buildConfig(env), new RegExp('Missing ' + key));
  }

  assert.throws(() => buildConfig({
    ...validEnv,
    E2E_TRACK_Y: validEnv.E2E_TRACK_X
  }), /must be different/);
});

test('requires Spotify loopback redirect to use the exact IPv4 literal and port', () => {
  assert.throws(() => buildConfig({
    ...validEnv,
    SPOTIFY_REDIRECT_URI: 'http://localhost:4173/'
  }), /must exactly equal/);
  assert.throws(() => buildConfig({
    ...validEnv,
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:4174/'
  }), /must exactly equal/);
  assert.throws(() => buildConfig({
    ...validEnv,
    PORT: '0'
  }), /PORT must be/);
});

test('serves the loopback test page and generated config without caching or exposing secrets', async t => {
  const config = buildConfig({
    ...validEnv,
    TWITCH_CLIENT_SECRET: 'never-expose-this',
    SPOTIFY_CLIENT_SECRET: 'never-expose-this',
    TWITCH_ACCESS_TOKEN: 'never-expose-this',
    SPOTIFY_REFRESH_TOKEN: 'never-expose-this'
  });
  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const origin = 'http://127.0.0.1:' + address.port;
  const configResponse = await fetch(origin + '/config.local.js');
  const configText = await configResponse.text();

  assert.equal(configResponse.status, 200);
  assert.match(configResponse.headers.get('content-type'), /javascript/);
  assert.match(configResponse.headers.get('cache-control'), /no-store/);
  assert.match(configText, /twitch-public-client-id/);
  assert.match(configText, /spotify-public-client-id/);
  assert.doesNotMatch(configText, /never-expose-this|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN/);

  const pageResponse = await fetch(origin + '/');
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Community Playlist Controller/);

  const moduleResponse = await fetch(origin + '/src/main.js');
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type'), /javascript/);

  const hiddenResponse = await fetch(origin + '/.env.e2e');
  assert.equal(hiddenResponse.status, 404);
  const docsResponse = await fetch(origin + '/README.md');
  assert.equal(docsResponse.status, 404);
  const traversalResponse = await fetch(origin + '/%2e%2e/.env.e2e');
  assert.equal(traversalResponse.status, 404);
});
