import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyClient } from '../src/spotify/client.js';

test('SpotifyClient can resume playback on the selected Connect device', async () => {
  let request;
  const client = new SpotifyClient({
    auth: { getAccessToken: async () => 'access' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    }
  });

  await client.resumePlayback('device id');

  assert.equal(request.url, 'https://api.spotify.com/v1/me/player/play?device_id=device%20id');
  assert.equal(request.options.method, 'PUT');
  assert.equal(request.options.headers.Authorization, 'Bearer access');
});

test('SpotifyClient can set shuffle and repeat states on a selected device', async () => {
  const requests = [];
  const client = new SpotifyClient({
    auth: { getAccessToken: async () => 'access' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    }
  });

  await client.setShuffle(false, 'device-1');
  await client.setRepeat('context', 'device-1');

  assert.equal(requests[0].url, 'https://api.spotify.com/v1/me/player/shuffle?state=false&device_id=device-1');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[1].url, 'https://api.spotify.com/v1/me/player/repeat?state=context&device_id=device-1');
  assert.equal(requests[1].options.method, 'PUT');
});

test('SpotifyClient rejects unsupported repeat modes before making a request', async () => {
  let called = false;
  const client = new SpotifyClient({
    auth: { getAccessToken: async () => 'access' },
    fetchImpl: async () => {
      called = true;
      return new Response(null, { status: 204 });
    }
  });

  assert.throws(() => client.setRepeat('all'), /repeat mode must be off, track, or context/);
  assert.equal(called, false);
});
