import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-modify-playback-state'
];

export const DEFAULT_SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:4173/';

function encryptionKey(value) {
  const key = Buffer.from(String(value || '').trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('SPOTIFY_PKCE_HANDOFF_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

export function validateSpotifyOAuthClientId(value) {
  const clientId = String(value || '').trim();
  if (!clientId) {
    throw new Error('SPOTIFY_CLIENT_ID is missing. Add the Spotify Web API OAuth Client ID as a repository Actions variable named SPOTIFY_CLIENT_ID.');
  }
  if (clientId.includes('*')) {
    throw new Error('SPOTIFY_CLIENT_ID appears to be masked. Store the public OAuth Client ID as a repository Actions variable; GitHub masks secrets in job summaries and would corrupt the authorization link.');
  }
  if (/^spak_/i.test(clientId)) {
    throw new Error('SPOTIFY_CLIENT_ID starts with spak_ and is a sensitive Spotify Soloist API key, not a Web API OAuth Client ID. Remove it from Actions Variables and revoke/rotate it because it has been exposed. This controller does not use Soloist keys. Set SPOTIFY_CLIENT_ID to the OAuth Client ID from your Spotify Developer Dashboard app settings.');
  }
  return clientId;
}

export function createSpotifyPkceHandoff({
  clientId,
  redirectUri = DEFAULT_SPOTIFY_REDIRECT_URI,
  now = Date.now()
}) {
  const spotifyClientId = validateSpotifyOAuthClientId(clientId);
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== 'http:' ||
    redirect.hostname !== '127.0.0.1' ||
    redirect.pathname !== '/' ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error('Spotify CI redirect URI must be http://127.0.0.1:4173/.');
  }

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const payload = {
    version: 1,
    verifier,
    state,
    redirectUri: redirect.toString(),
    createdAt: now
  };

  const authorizationUrl = new URL('https://accounts.spotify.com/authorize');
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: spotifyClientId,
    scope: SPOTIFY_SCOPES.join(' '),
    redirect_uri: payload.redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge
  }).toString();

  return { payload, authorizationUrl: authorizationUrl.toString() };
}

export function encryptSpotifyPkceHandoff(payload, keyValue) {
  const key = encryptionKey(keyValue);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

export function decryptSpotifyPkceHandoff(envelope, keyValue, now = Date.now()) {
  const key = encryptionKey(keyValue);
  if (!envelope || envelope.version !== 1 || !envelope.iv || !envelope.tag || !envelope.data) {
    throw new Error('Spotify PKCE handoff artifact is missing or invalid.');
  }

  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt the Spotify PKCE handoff artifact. Check SPOTIFY_PKCE_HANDOFF_KEY.');
  }

  const payload = JSON.parse(plaintext);
  if (
    payload.version !== 1 ||
    typeof payload.verifier !== 'string' ||
    payload.verifier.length < 43 ||
    typeof payload.state !== 'string' ||
    payload.state.length < 32 ||
    !Number.isFinite(payload.createdAt) ||
    now - payload.createdAt > 24 * 60 * 60 * 1000 ||
    payload.createdAt > now + 60_000 ||
    payload.redirectUri !== DEFAULT_SPOTIFY_REDIRECT_URI
  ) {
    throw new Error('Spotify PKCE handoff is invalid or expired. Start a new Spotify authorization stage.');
  }
  return payload;
}

export function parseSpotifyCallbackUrl(callbackValue, handoff) {
  let callback;
  try {
    callback = new URL(String(callbackValue || '').trim());
  } catch {
    throw new Error('Paste the complete Spotify redirect URL from the browser address bar.');
  }

  const receivedRedirectUri = callback.origin + callback.pathname;
  if (receivedRedirectUri !== handoff.redirectUri) {
    throw new Error(
      'Spotify callback URL does not match the registered loopback redirect URI. Expected ' +
      handoff.redirectUri + ' but received ' + receivedRedirectUri +
      '. Keep the hostname, port, and trailing slash exactly as shown in the Spotify authorization link. The authorization code and state are intentionally omitted.'
    );
  }

  const providerError = callback.searchParams.get('error');
  if (providerError) throw new Error('Spotify authorization was denied: ' + providerError);

  const code = callback.searchParams.get('code');
  if (!code) {
    throw new Error('The Spotify callback URL has no authorization code. After approving Spotify, copy the entire URL from the browser address bar, including ?code=...&state=...; do not enter only http://127.0.0.1:4173/.');
  }

  const state = callback.searchParams.get('state');
  if (!state) {
    throw new Error('The Spotify callback URL has no state parameter. Copy the complete URL after Spotify approval, including both code and state.');
  }
  if (state !== handoff.state) {
    throw new Error('The Spotify callback state does not match the PKCE handoff. Use the callback URL from the same authorize_spotify run whose numeric run ID you entered.');
  }

  return { code, state };
}

async function createArtifact() {
  const { clientId, key, summaryPath } = {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    key: process.env.SPOTIFY_PKCE_HANDOFF_KEY,
    summaryPath: process.env.GITHUB_STEP_SUMMARY
  };
  if (!key) throw new Error('Missing GitHub Actions secret SPOTIFY_PKCE_HANDOFF_KEY.');
  const { payload, authorizationUrl } = createSpotifyPkceHandoff({
    clientId,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || DEFAULT_SPOTIFY_REDIRECT_URI
  });
  const artifact = encryptSpotifyPkceHandoff(payload, key);
  const outputDirectory = resolve('.ci-auth');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, 'spotify-pkce-handoff.json'), JSON.stringify(artifact), { mode: 0o600 });

  const runId = process.env.GITHUB_RUN_ID || '(see this workflow run URL)';
  const summary = [
    '# Spotify approval required',
    '',
    '1. [Open Spotify authorization](' + authorizationUrl + ') and approve the requested playback and playlist permissions.',
    '2. Spotify will redirect to `' + payload.redirectUri + '`. The local page may fail to load; that is expected because the callback is being exchanged by this GitHub Actions run.',
    '3. Copy the **complete URL from the browser address bar**. It contains a short-lived authorization code and state.',
    '4. Start this workflow again with stage `run_live_test`, set `spotify_auth_run_id` to `' + runId + '`, and paste the complete URL into `spotify_callback_url`.',
    '',
    'The encrypted PKCE verifier is stored in a one-day Actions artifact. It is not printed in the logs or included in the authorization URL.',
    ''
  ].join('\n');

  if (summaryPath) await appendFile(summaryPath, summary);
  console.info('[community-playlist:ci] Spotify authorization URL added to the workflow summary.');
  console.info('[community-playlist:ci] This authorization run ID is ' + runId + '.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== 'create') {
    console.error('Usage: node scripts/e2e/spotify-pkce-handoff.js create');
    process.exitCode = 2;
  } else {
    createArtifact().catch(error => {
      console.error('[community-playlist:ci] Spotify authorization setup failed: ' + error.message);
      process.exitCode = 1;
    });
  }
}
