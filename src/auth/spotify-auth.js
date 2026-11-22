const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

function randomBase64Url(byteLength = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createPkce() {
  const verifier = randomBase64Url(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return { verifier, challenge };
}

async function exchange(values, fetchImpl) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('Spotify OAuth failed (HTTP ' + response.status + '): ' + (body.error_description || body.error || 'unknown error'));
  }
  return body;
}

export class SpotifyAuth {
  constructor({ clientId, redirectUri, scopes, tokenStore, pkceStore = tokenStore, fetchImpl = fetch, locationRef = location, historyRef = history }) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
    this.tokenStore = tokenStore;
    this.pkceStore = pkceStore;
    this.fetch = fetchImpl;
    this.location = locationRef;
    this.history = historyRef;
    this.session = tokenStore.load();
    this.refreshPromise = null;
  }

  async handleRedirect() {
    const url = new URL(this.location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!code && !error) return false;

    const pending = this.pkceStore.load();
    this.history.replaceState({}, this.location.title || 'Community Playlist', this.location.pathname);
    if (error) {
      this.pkceStore.clear();
      throw new Error('Spotify authorization was denied: ' + error);
    }
    if (!pending?.state || url.searchParams.get('state') !== pending.state || !pending.verifier) {
      this.pkceStore.clear();
      throw new Error('Spotify OAuth state validation failed. Run communityPlaylist.start() again.');
    }

    try {
      const token = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: pending.verifier
      }, this.fetch);
      this.acceptToken(token);
      return true;
    } finally {
      this.pkceStore.clear();
    }
  }

  acceptToken(token) {
    if (!token.access_token) throw new Error('Spotify did not return an access token.');
    this.session = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || this.session?.refreshToken || null,
      expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      scopes: token.scope ? token.scope.split(' ') : this.scopes
    };
    this.tokenStore.save(this.session);
  }

  async beginAuthorization() {
    const { verifier, challenge } = await createPkce();
    const state = randomBase64Url(24);
    this.pkceStore.save({ verifier, state, createdAt: Date.now() });

    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: this.scopes.join(' '),
      redirect_uri: this.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge
    }).toString();
    this.location.assign(url.toString());
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      if (!this.session?.refreshToken) {
        this.tokenStore.clear();
        this.session = null;
        throw new Error('Spotify authorization expired. Run communityPlaylist.start() again.');
      }
      try {
        const token = await exchange({
          grant_type: 'refresh_token',
          refresh_token: this.session.refreshToken,
          client_id: this.clientId
        }, this.fetch);
        this.acceptToken(token);
        return this.session.accessToken;
      } catch (error) {
        if (error.message.includes('invalid_grant') || error.message.includes('invalid refresh token')) {
          this.tokenStore.clear();
          this.session = null;
        }
        throw error;
      }
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async getAccessToken() {
    if (!this.session?.accessToken) {
      throw new Error('Connect Spotify first by running communityPlaylist.start().');
    }
    if (this.session.expiresAt <= Date.now() + 60000) await this.refresh();
    return this.session.accessToken;
  }
}
