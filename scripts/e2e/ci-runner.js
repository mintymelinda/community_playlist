import { readFile } from 'node:fs/promises';
import { startE2EServer } from './server.js';

function validateSession(session) {
  for (const provider of ['spotify', 'twitch']) {
    const token = session?.[provider];
    if (
      !token ||
      typeof token.accessToken !== 'string' ||
      !token.accessToken ||
      typeof token.refreshToken !== 'string' ||
      !token.refreshToken ||
      !Number.isFinite(token.expiresAt) ||
      !Array.isArray(token.scopes)
    ) {
      throw new Error('Prepared ' + provider + ' OAuth session is missing required token data. Run the OAuth preparation step before the live test.');
    }
  }
  return session;
}

async function readOAuthSession() {
  try {
    return validateSession(JSON.parse(await readFile('.ci-auth/oauth-session.json', 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Prepared OAuth session is missing. Run scripts/e2e/prepare-oauth.js before the live test.');
    }
    throw error;
  }
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
  const auth = await readOAuthSession();
  const port = 4173;
  const env = {
    ...process.env,
    PORT: String(port),
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/',
    TWITCH_CLIENT_ID: String(process.env.TWITCH_CLIENT_ID || '').trim(),
    SPOTIFY_CLIENT_ID: String(process.env.SPOTIFY_CLIENT_ID || '').trim(),
    SPOTIFY_PLAYLIST_URI: String(process.env.SPOTIFY_PLAYLIST_URI || '').trim(),
    E2E_TRACK_X: String(process.env.E2E_TRACK_X || '').trim(),
    E2E_TRACK_Y: String(process.env.E2E_TRACK_Y || '').trim(),
    TWITCH_BROADCASTER_ID: String(process.env.TWITCH_BROADCASTER_ID || '').trim(),
    TWITCH_POWER_UP_ID: String(process.env.TWITCH_POWER_UP_ID || '').trim(),
    SPOTIFY_DEVICE_ID: String(process.env.SPOTIFY_DEVICE_ID || '').trim(),
    POLL_INTERVAL_MS: String(process.env.POLL_INTERVAL_MS || '2000')
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
    await context.addInitScript(({ twitch, spotify }) => {
      const now = Date.now();
      localStorage.removeItem('community-playlist-e2e-queue-v1');
      sessionStorage.removeItem('community-playlist-e2e-initialized');
      sessionStorage.setItem('community-playlist-e2e-twitch-token', JSON.stringify({
        accessToken: twitch.accessToken,
        refreshToken: twitch.refreshToken,
        expiresAt: twitch.expiresAt,
        scopes: twitch.scopes
      }));
      sessionStorage.setItem('community-playlist-e2e-spotify-token', JSON.stringify({
        accessToken: spotify.accessToken,
        refreshToken: spotify.refreshToken,
        expiresAt: spotify.expiresAt,
        scopes: spotify.scopes
      }));
      void now;
    }, { twitch: auth.twitch, spotify: auth.spotify });

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
      console.info('[community-playlist:ci] Real chat test enabled. Send the requested chat messages when prompted in the Actions log.');
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
