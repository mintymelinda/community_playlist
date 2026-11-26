import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TwitchAuth } from '../../src/auth/twitch-auth.js';
import { TokenStore } from '../../src/lib/token-store.js';
import { readOptionalWorkflowDispatchInput } from './workflow-input.js';
import {
  decryptSpotifyPkceHandoff,
  parseSpotifyCallbackUrl,
  SPOTIFY_SCOPES,
  validateSpotifyOAuthClientId
} from './spotify-pkce-handoff.js';
import { decryptOAuthVault, encryptOAuthVault } from './oauth-vault.js';

const TWITCH_SCOPES = ['bits:read', 'user:read:chat'];
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const VAULT_PATH = resolve('.ci-auth/community-playlist-oauth-vault.json');
const SESSION_PATH = resolve('.ci-auth/oauth-session.json');
const TWITCH_TOKEN_KEY = 'community-playlist-ci-twitch-token';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error('Missing required GitHub Actions variable or secret: ' + name);
  return value;
}

function hasScopes(granted, requiredScopes) {
  const scopes = new Set(Array.isArray(granted) ? granted : []);
  return requiredScopes.every(scope => scopes.has(scope));
}

async function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

function mask(value) {
  if (value) console.info('::add-mask::' + value);
}

async function readExistingVault(key) {
  try {
    const envelope = JSON.parse(await readFile(VAULT_PATH, 'utf8'));
    return decryptOAuthVault(envelope, key);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function spotifyTokenRequest(values) {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Spotify OAuth token request failed (HTTP ' + response.status + '): ' + (body.error_description || body.error || 'unknown error'));
    error.status = response.status;
    error.oauthError = body.error;
    throw error;
  }
  if (!body.access_token) throw new Error('Spotify OAuth did not return an access token.');
  return body;
}

function spotifySession(token, refreshToken, scopes) {
  const expiresIn = Math.max(60, Number(token.expires_in) || 3600);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: token.scope ? String(token.scope).split(' ').filter(Boolean) : [...scopes]
  };
}

async function authorizeSpotifyWithPkce() {
  const runId = await readOptionalWorkflowDispatchInput('spotify_auth_run_id');
  const callbackValue = await readOptionalWorkflowDispatchInput('spotify_callback_url');
  if (!runId || !callbackValue) {
    throw new Error(
      'Spotify has no reusable refresh token. For first-time setup or reauthorization, run the workflow with stage authorize_spotify, approve Spotify, then run stage run_live_test with that authorization run ID and the complete callback URL.'
    );
  }

  mask(callbackValue);
  let envelope;
  try {
    envelope = JSON.parse(await readFile('.ci-auth/spotify-pkce-handoff.json', 'utf8'));
  } catch {
    throw new Error('The Spotify PKCE handoff artifact was not downloaded. Check spotify_auth_run_id and use the matching authorize_spotify run.');
  }
  const handoff = decryptSpotifyPkceHandoff(envelope, required('SPOTIFY_PKCE_HANDOFF_KEY'));
  const callback = parseSpotifyCallbackUrl(callbackValue, handoff);
  mask(callback.code);

  const clientId = validateSpotifyOAuthClientId(required('SPOTIFY_CLIENT_ID'));
  const token = await spotifyTokenRequest({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: handoff.redirectUri,
    client_id: clientId,
    code_verifier: handoff.verifier
  });
  if (!token.refresh_token) {
    throw new Error('Spotify did not return a refresh token. Verify the Spotify app authorization flow and repeat the one-time approval.');
  }

  const scopes = token.scope ? String(token.scope).split(' ').filter(Boolean) : [];
  const missing = SPOTIFY_SCOPES.filter(scope => !scopes.includes(scope));
  if (missing.length) {
    throw new Error('Spotify authorization is missing required scopes: ' + missing.join(', ') + '. Approve all requested permissions and repeat the authorization.');
  }
  console.info('[community-playlist:ci] Spotify one-time PKCE authorization: PASS');
  return spotifySession(token, token.refresh_token, scopes);
}

async function obtainSpotifySession(vault) {
  const clientId = validateSpotifyOAuthClientId(required('SPOTIFY_CLIENT_ID'));
  if (vault?.spotify?.refreshToken && hasScopes(vault.spotify.scopes, SPOTIFY_SCOPES)) {
    try {
      const token = await spotifyTokenRequest({
        grant_type: 'refresh_token',
        refresh_token: vault.spotify.refreshToken,
        client_id: clientId
      });
      const session = spotifySession(token, vault.spotify.refreshToken, vault.spotify.scopes);
      if (!hasScopes(session.scopes, SPOTIFY_SCOPES)) {
        throw new Error('Spotify refresh response no longer has all required scopes.');
      }
      console.info('[community-playlist:ci] Reused saved Spotify authorization and refreshed its access token.');
      return session;
    } catch (error) {
      if (error.oauthError !== 'invalid_grant' && !/no longer has all required scopes/i.test(error.message)) {
        throw error;
      }
      console.warn('[community-playlist:ci] Saved Spotify refresh token is no longer usable; one-time authorization is required.');
    }
  }
  return authorizeSpotifyWithPkce();
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

function createTwitchAuth(existingCredential) {
  const storage = new MemoryStorage();
  const tokenStore = new TokenStore(storage, TWITCH_TOKEN_KEY);
  if (existingCredential?.refreshToken) {
    tokenStore.save({
      accessToken: 'expired-access-token',
      refreshToken: existingCredential.refreshToken,
      expiresAt: 0,
      scopes: existingCredential.scopes || []
    });
  }

  return new TwitchAuth({
    clientId: required('TWITCH_CLIENT_ID'),
    scopes: TWITCH_SCOPES,
    tokenStore,
    onDeviceCode: info => {
      const summary = [
        '## Twitch broadcaster approval required',
        '',
        '1. Open [' + info.verificationUri + '](' + info.verificationUri + ').',
        '2. Enter this one-time code: **' + info.userCode + '**.',
        '3. Approve access using the broadcaster account configured for this channel.',
        '',
        'CI is waiting for approval and will continue automatically.',
        ''
      ].join('\n');
      appendSummary(summary).catch(() => {});
      console.info('[community-playlist:ci] Twitch approval required. Open ' + info.verificationUri + ' and enter code ' + info.userCode + '.');
    }
  });
}

function shouldReauthorizeTwitch(error) {
  return /invalid refresh token|invalid_grant|missing required scopes|different Client ID|different account than TWITCH_BROADCASTER_ID/i.test(error?.message || '');
}

function validateTwitchIdentity(identity) {
  const expectedBroadcaster = String(process.env.TWITCH_BROADCASTER_ID || '').trim();
  if (expectedBroadcaster && String(identity?.user_id) !== expectedBroadcaster) {
    throw new Error('The saved Twitch authorization belongs to a different account than TWITCH_BROADCASTER_ID. Reauthorize Twitch using the configured broadcaster account.');
  }
  return identity;
}

async function obtainTwitchSession(vault, persistCredential) {
  const hasReusableCredential = Boolean(
    vault?.twitch?.refreshToken &&
    hasScopes(vault.twitch.scopes, TWITCH_SCOPES)
  );
  if (!hasReusableCredential && vault?.twitch) {
    await persistCredential(null, null);
  }
  let twitchAuth = createTwitchAuth(hasReusableCredential ? vault.twitch : null);

  if (hasReusableCredential) {
    try {
      await twitchAuth.getAccessToken();
      await persistCredential(twitchAuth.session, null);
      const identity = validateTwitchIdentity(await twitchAuth.validate());
      await persistCredential(twitchAuth.session, identity);
      console.info('[community-playlist:ci] Reused saved Twitch authorization and refreshed its access token.');
      return { auth: twitchAuth, identity };
    } catch (error) {
      if (!shouldReauthorizeTwitch(error)) throw error;
      console.warn('[community-playlist:ci] Saved Twitch refresh token is no longer usable; requesting broadcaster approval again.');
      twitchAuth.tokenStore.clear();
      twitchAuth.session = null;
      await persistCredential(null, null);
    }
  }

  try {
    await twitchAuth.authorize();
  } catch (error) {
    if (twitchAuth.session?.refreshToken) await persistCredential(twitchAuth.session, twitchAuth.identity);
    throw error;
  }
  const identity = validateTwitchIdentity(twitchAuth.identity || await twitchAuth.validate());
  await persistCredential(twitchAuth.session, identity);
  console.info('[community-playlist:ci] Twitch Device Code authorization: PASS');
  return { auth: twitchAuth, identity };
}

async function writePrivateJson(path, value) {
  const directory = resolve('.ci-auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = path + '.tmp';
  await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function main() {
  const key = required('SPOTIFY_PKCE_HANDOFF_KEY');
  const vault = await readExistingVault(key) || {
    version: 1,
    updatedAt: Date.now(),
    spotify: null,
    twitch: null
  };
  const persistVault = async () => {
    vault.updatedAt = Date.now();
    await writePrivateJson(VAULT_PATH, encryptOAuthVault(vault, key));
  };

  const spotify = await obtainSpotifySession(vault);
  if (!spotify.refreshToken) {
    throw new Error('Spotify did not provide a refresh token, so its authorization cannot be reused on the next run.');
  }
  vault.spotify = {
    refreshToken: spotify.refreshToken,
    scopes: spotify.scopes
  };
  await persistVault();

  const persistTwitchCredential = async (session, identity) => {
    if (!session?.refreshToken) {
      vault.twitch = null;
      await persistVault();
      return;
    }
    vault.twitch = {
      refreshToken: session.refreshToken,
      scopes: identity?.scopes || session.scopes || vault.twitch?.scopes || TWITCH_SCOPES,
      ...(identity?.user_id || vault.twitch?.userId
        ? { userId: String(identity?.user_id || vault.twitch.userId) }
        : {})
    };
    await persistVault();
  };
  const twitchResult = await obtainTwitchSession(vault, persistTwitchCredential);
  const twitch = twitchResult.auth.session;
  const identity = twitchResult.identity;

  if (!twitch?.refreshToken) {
    throw new Error('Twitch did not provide a refresh token, so its authorization cannot be reused on the next run.');
  }

  vault.twitch = {
    refreshToken: twitch.refreshToken,
    scopes: identity.scopes || TWITCH_SCOPES,
    userId: String(identity.user_id)
  };
  await persistVault();

  const session = {
    spotify,
    twitch: {
      accessToken: twitch.accessToken,
      refreshToken: twitch.refreshToken,
      expiresAt: twitch.expiresAt,
      scopes: identity.scopes || TWITCH_SCOPES,
      userId: String(identity.user_id)
    }
  };

  await writePrivateJson(SESSION_PATH, session);
  mask(spotify.accessToken);
  mask(spotify.refreshToken);
  mask(twitch.accessToken);
  mask(twitch.refreshToken);
  console.info('[community-playlist:ci] Encrypted Spotify and Twitch refresh-token vault updated.');
  await appendSummary([
    '## OAuth session ready',
    '',
    'Spotify and Twitch credentials were obtained without exposing provider tokens. The encrypted refresh-token vault has been updated before the live playback tests begin.',
    '',
    'Future runs can select stage run_live_test without supplying a Spotify callback URL or repeating Twitch approval. Provider approval is requested again only when a saved refresh token is missing, revoked, invalid, or lacks a required permission.',
    ''
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('[community-playlist:ci] OAuth preparation failed: ' + error.message);
    process.exitCode = 1;
  });
}
