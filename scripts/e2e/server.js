import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOST = '127.0.0.1';

function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadLocalEnvironment(root = ROOT) {
  try {
    const source = await readFile(join(root, '.env.e2e'), 'utf8');
    return parseEnvFile(source);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function required(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error('Missing ' + key + ' in .env.e2e or the process environment.');
  return value;
}

export function buildConfig(env = process.env) {
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }

  const expectedRedirect = 'http://' + HOST + ':' + port + '/';
  const redirectUri = String(env.SPOTIFY_REDIRECT_URI || expectedRedirect).trim();
  if (redirectUri !== expectedRedirect) {
    throw new Error('SPOTIFY_REDIRECT_URI must exactly equal ' + expectedRedirect + '. The E2E server only binds to 127.0.0.1.');
  }

  const twitchClientId = required(env, 'TWITCH_CLIENT_ID');
  const spotifyClientId = required(env, 'SPOTIFY_CLIENT_ID');
  const playlistUri = required(env, 'SPOTIFY_PLAYLIST_URI');
  const e2eTrackX = required(env, 'E2E_TRACK_X');
  const e2eTrackY = required(env, 'E2E_TRACK_Y');
  if (e2eTrackX === e2eTrackY) throw new Error('E2E_TRACK_X and E2E_TRACK_Y must be different.');

  return Object.freeze({
    twitchClientId,
    spotifyClientId,
    spotifyRedirectUri: redirectUri,
    playlistUri,
    broadcasterId: String(env.TWITCH_BROADCASTER_ID || '').trim(),
    powerUpId: String(env.TWITCH_POWER_UP_ID || '').trim(),
    spotifyDeviceId: String(env.SPOTIFY_DEVICE_ID || '').trim(),
    pollIntervalMs: Math.max(1000, Number(env.POLL_INTERVAL_MS) || 2000),
    maxPendingRequests: 10,
    e2eMode: true,
    e2eTrackX,
    e2eTrackY
  });
}

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self' https://id.twitch.tv https://api.twitch.tv https://accounts.spotify.com https://api.spotify.com wss://eventsub.wss.twitch.tv; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  response.end(body);
}

function safeStaticPath(pathname, root = ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;

  const normalized = normalize(decoded).replace(/^([/\\])+/, '');
  if (normalized === '' || normalized === 'index.html') return join(resolve(root), 'index.html');
  if (!normalized.startsWith('src' + sep) || extname(normalized) !== '.js') return null;
  if (normalized.split(sep).some(part => !part || part.startsWith('.'))) return null;

  const base = resolve(root);
  const candidate = resolve(base, normalized);
  return candidate.startsWith(base + sep) ? candidate : null;
}

export function createServer(config, root = ROOT) {
  const server = http.createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(response, 405, 'Method not allowed.');
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://' + HOST).pathname;
    } catch {
      send(response, 400, 'Bad request.');
      return;
    }

    if (pathname === '/config.local.js') {
      const body = 'export default ' + JSON.stringify(config) + ';\n';
      send(response, 200, request.method === 'HEAD' ? '' : body, 'text/javascript; charset=utf-8');
      return;
    }

    const file = safeStaticPath(pathname, root);
    if (!file) {
      send(response, 404, 'Not found.');
      return;
    }

    try {
      const body = await readFile(file);
      const type = extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
      send(response, 200, request.method === 'HEAD' ? '' : body, type);
    } catch (error) {
      send(response, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found.' : 'Server error.');
    }
  });

  return server;
}

export async function startE2EServer({ env = process.env, root = ROOT, logger = console } = {}) {
  const localEnv = await loadLocalEnvironment(root);
  const mergedEnv = { ...localEnv, ...env };
  const config = buildConfig(mergedEnv);
  const port = Number(mergedEnv.PORT || 4173);
  const server = createServer(config, root);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolveListen);
  });
  logger.info('[community-playlist:e2e] Local test server listening at http://' + HOST + ':' + port + '/');
  logger.info('[community-playlist:e2e] OAuth credentials are not loaded from .env.e2e.');
  return server;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  startE2EServer().catch(error => {
    console.error('[community-playlist:e2e] Could not start local test server:', error.message);
    process.exitCode = 1;
  });
}
