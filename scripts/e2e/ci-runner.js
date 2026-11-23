import { startE2EServer } from './server.js';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error('Missing required GitHub Actions secret or variable: ' + name);
  return value;
}

function optional(name) {
  return String(process.env[name] || '').trim();
}

function reportResult(name, result) {
  if (!result?.passed) {
    const failures = (result?.checks || [])
      .filter(check => !check.passed)
      .map(check => check.name + (check.error ? ': ' + check.error : ''));
    throw new Error(name + ' failed' + (failures.length ? ': ' + failures.join('; ') : '.'));
  }

  console.info('[community-playlist:ci] ' + name + ': PASS');
  for (const check of result.checks || []) {
    console.info('[community-playlist:ci]   PASS ' + check.name);
  }
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function main() {
  const port = 4173;
  const twitchAccessToken = required('TWITCH_ACCESS_TOKEN');
  const spotifyAccessToken = required('SPOTIFY_ACCESS_TOKEN');
  const env = {
    ...process.env,
    PORT: String(port),
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/',
    TWITCH_CLIENT_ID: required('TWITCH_CLIENT_ID'),
    SPOTIFY_CLIENT_ID: required('SPOTIFY_CLIENT_ID'),
    SPOTIFY_PLAYLIST_URI: required('SPOTIFY_PLAYLIST_URI'),
    E2E_TRACK_X: required('E2E_TRACK_X'),
    E2E_TRACK_Y: required('E2E_TRACK_Y'),
    TWITCH_BROADCASTER_ID: optional('TWITCH_BROADCASTER_ID'),
    TWITCH_POWER_UP_ID: optional('TWITCH_POWER_UP_ID'),
    SPOTIFY_DEVICE_ID: optional('SPOTIFY_DEVICE_ID'),
    POLL_INTERVAL_MS: optional('POLL_INTERVAL_MS') || '2000'
  };

  let server;
  let browser;
  try {
    server = await startE2EServer({
      env,
      logger: { info: message => console.info(message) }
    });

    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(({ twitchToken, spotifyToken }) => {
      const now = Date.now();
      localStorage.removeItem('community-playlist-e2e-queue-v1');
      sessionStorage.removeItem('community-playlist-e2e-initialized');
      sessionStorage.setItem('community-playlist-e2e-twitch-token', JSON.stringify({
        accessToken: twitchToken,
        refreshToken: null,
        expiresAt: now + 45 * 60 * 1000,
        scopes: ['bits:read', 'user:read:chat']
      }));
      sessionStorage.setItem('community-playlist-e2e-spotify-token', JSON.stringify({
        accessToken: spotifyToken,
        refreshToken: null,
        expiresAt: now + 45 * 60 * 1000,
        scopes: [
          'user-read-playback-state',
          'playlist-read-private',
          'playlist-read-collaborative',
          'user-modify-playback-state'
        ]
      }));
    }, { twitchToken: twitchAccessToken, spotifyToken: spotifyAccessToken });

    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on('console', message => {
      const value = message.text();
      if (value.startsWith('[community-playlist:e2e]')) {
        console.info(value);
      }
    });

    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof globalThis.communityPlaylist?.start === 'function' &&
        typeof globalThis.communityPlaylist?.e2e?.preflight === 'function',
      null,
      { timeout: 30000 }
    );

    await page.evaluate(() => globalThis.communityPlaylist.start());
    console.info('[community-playlist:ci] Browser controller connected to Twitch EventSub.');

    await page.evaluate(() => globalThis.communityPlaylist.e2e.preflight());
    console.info('[community-playlist:ci] Live preflight: PASS');

    const playbackResult = await page.evaluate(
      () => globalThis.communityPlaylist.e2e.runPlaybackSequence()
    );
    reportResult('Spotify playback sequence', playbackResult);

    const reconnectResult = await page.evaluate(
      () => globalThis.communityPlaylist.e2e.verifyEventSubReconnect()
    );
    reportResult('Twitch EventSub reconnect', reconnectResult);

    if (process.env.RUN_REAL_CHAT_TEST === 'true') {
      console.info('[community-playlist:ci] Real chat test enabled. Follow the next prompts in Twitch chat.');
      const chatResult = await page.evaluate(
        () => globalThis.communityPlaylist.e2e.runRealChatSkipTest()
      );
      reportResult('Real Twitch chat authorization and skip', chatResult);
    }

    console.info('[community-playlist:ci] All selected live E2E checks passed.');
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }
}

main().catch(error => {
  console.error('[community-playlist:ci] FAILED: ' + error.message);
  process.exitCode = 1;
});
