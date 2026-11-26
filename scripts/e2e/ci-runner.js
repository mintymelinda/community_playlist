import { readFile } from 'node:fs/promises';
import { readWorkflowDispatchInput } from './workflow-input.js';
import { startE2EServer } from './server.js';
import { TwitchAuth } from '../../src/auth/twitch-auth.js';
import { TokenStore } from '../../src/lib/token-store.js';
import {
  decryptSpotifyPkceHandoff,
  parseSpotifyCallbackUrl,
  SPOTIFY_SCOPES,
  validateSpotifyOAuthClientId
} from './spotify-pkce-handoff.js';

const TWITCH_SCOPES = ['bits:read', 'user:read:chat'];
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error('Missing required GitHub Actions variable or secret: ' + name);
  return value;
}

function optional(name) {
  return String(process.env[name] || '').trim();
}

async function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

async function obtainSpotifyAccessToken() {
  const key = required('SPOTIFY_PKCE_HANDOFF_KEY');
  const callbackValue = await readWorkflowDispatchInput('spotify_callback_url');
  console.info('::add-mask::' + callbackValue);
  const envelope = JSON.parse(await readFile('.ci-auth/spotify-pkce-handoff.json', 'utf8'));
  const handoff = decryptSpotifyPkceHandoff(envelope, key);
  const callback = parseSpotifyCallbackUrl(callbackValue, handoff);
  console.info('::add-mask::' + callback.code);

  const spotifyClientId = validateSpotifyOAuthClientId(required('SPOTIFY_CLIENT_ID'));
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: handoff.redirectUri,
      client_id: spotifyClientId,
      code_verifier: handoff.verifier
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('Spotify OAuth token exchange failed (HTTP ' + response.status + '): ' + (body.error_description || body.error || 'unknown error'));
  }
  if (!body.access_token) throw new Error('Spotify OAuth did not return an access token.');

  const scopes = String(body.scope || '').split(' ').filter(Boolean);
  const missingScopes = SPOTIFY_SCOPES.filter(scope => !scopes.includes(scope));
  if (missingScopes.length) {
    throw new Error('Spotify authorization is missing required scopes: ' + missingScopes.join(', ') + '. Start a new Spotify authorization stage and approve all permissions.');
  }

  console.info('[community-playlist:ci] Spotify PKCE authorization and token exchange: PASS.');
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in) || 3600,
    scopes
  };
}

async function authorizeTwitchDeviceCode() {
  const twitchAuth = new TwitchAuth({
    clientId: required('TWITCH_CLIENT_ID'),
    scopes: TWITCH_SCOPES,
    tokenStore: new TokenStore(new MemoryStorage(), 'community-playlist-ci-twitch-token'),
    onDeviceCode: info => {
      const prompt = [
        '## Twitch broadcaster approval required',
        '',
        '1. Open [' + info.verificationUri + '](' + info.verificationUri + ').',
        '2. Enter this one-time code: **' + info.userCode + '**.',
        '3. Approve the requested permissions using the broadcaster account configured for this channel.',
        '',
        'The workflow is waiting for approval and will continue automatically.',
        ''
      ].join('\n');
      appendSummary(prompt).catch(() => {});
      console.info('[community-playlist:ci] Twitch approval required. Open ' + info.verificationUri + ' and enter code ' + info.userCode + '.');
    }
  });

  await twitchAuth.authorize();
  const expectedBroadcaster = optional('TWITCH_BROADCASTER_ID');
  if (expectedBroadcaster && String(twitchAuth.identity?.user_id) !== expectedBroadcaster) {
    throw new Error('The Twitch account that approved Device Code authorization does not match TWITCH_BROADCASTER_ID.');
  }

  console.info('[community-playlist:ci] Twitch Device Code authorization and broadcaster validation: PASS.');
  return {
    accessToken: twitchAuth.session.accessToken,
    expiresIn: Math.max(60, (twitchAuth.session.expiresAt - Date.now()) / 1000),
    scopes: twitchAuth.identity.scopes || TWITCH_SCOPES,
    userId: twitchAuth.identity.user_id
  };
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
  const spotifyToken = await obtainSpotifyAccessToken();
  const twitchToken = await authorizeTwitchDeviceCode();
  const port = 4173;
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
    await context.addInitScript(({ twitch, spotify }) => {
      const now = Date.now();
      localStorage.removeItem('community-playlist-e2e-queue-v1');
      sessionStorage.removeItem('community-playlist-e2e-initialized');
      sessionStorage.setItem('community-playlist-e2e-twitch-token', JSON.stringify({
        accessToken: twitch.accessToken,
        refreshToken: null,
        expiresAt: now + twitch.expiresIn * 1000,
        scopes: twitch.scopes
      }));
      sessionStorage.setItem('community-playlist-e2e-spotify-token', JSON.stringify({
        accessToken: spotify.accessToken,
        refreshToken: null,
        expiresAt: now + spotify.expiresIn * 1000,
        scopes: spotify.scopes
      }));
    }, { twitch: twitchToken, spotify: spotifyToken });

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
