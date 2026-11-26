const TWITCH_DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function postForm(url, values, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error_description || body.error || 'HTTP ' + response.status);
    error.status = response.status;
    error.oauthError = body.message || body.error;
    throw error;
  }
  return body;
}

export class TwitchAuth {
  constructor({ clientId, clientSecret = '', scopes, tokenStore, fetchImpl = globalThis.fetch.bind(globalThis), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onDeviceCode = info => console.info('[community-playlist] Twitch authorization required:', info) }) {
    this.clientId = clientId;
    this.clientSecret = String(clientSecret || '').trim();
    this.scopes = scopes;
    this.tokenStore = tokenStore;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.onDeviceCode = onDeviceCode;
    this.session = tokenStore.load();
    this.refreshPromise = null;
    this.identity = null;
  }

  acceptToken(token) {
    if (!token.access_token) throw new Error('Twitch did not return an access token.');
    this.session = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || this.session?.refreshToken || null,
      expiresAt: Date.now() + (Number(token.expires_in) || 14400) * 1000,
      scopes: Array.isArray(token.scope) ? token.scope : this.scopes
    };
    this.tokenStore.save(this.session);
  }

  async authorize() {
    const device = await postForm(TWITCH_DEVICE_URL, {
      client_id: this.clientId,
      scopes: this.scopes.join(' ')
    }, this.fetch);

    if (!device.device_code || !device.user_code || !device.verification_uri) {
      throw new Error('Twitch returned an incomplete Device Code response.');
    }

    this.onDeviceCode({
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      userCode: device.user_code,
      expiresIn: device.expires_in
    });

    const deadline = Date.now() + Number(device.expires_in) * 1000;
    let interval = Math.max(1, Number(device.interval) || 5) * 1000;

    while (Date.now() < deadline) {
      await this.sleep(interval);
      try {
        const token = await postForm(TWITCH_TOKEN_URL, {
          client_id: this.clientId,
          device_code: device.device_code,
          grant_type: DEVICE_GRANT
        }, this.fetch);
        if (!token.refresh_token) throw new Error('Twitch Device Code authorization did not return a refresh token.');
        this.acceptToken(token);
        await this.validate();
        return this.session;
      } catch (error) {
        if (error.oauthError === 'authorization_pending') continue;
        if (error.oauthError === 'slow_down') {
          interval += 5000;
          continue;
        }
        throw error;
      }
    }

    throw new Error('Twitch Device Code authorization expired. Start again.');
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      if (!this.session?.refreshToken) {
        this.tokenStore.clear();
        this.session = null;
        throw new Error('Twitch authorization expired. Run communityPlaylist.start() again.');
      }

      try {
        const token = await postForm(TWITCH_TOKEN_URL, {
          client_id: this.clientId,
          grant_type: 'refresh_token',
          refresh_token: this.session.refreshToken,
          ...(this.clientSecret ? { client_secret: this.clientSecret } : {})
        }, this.fetch);
        this.acceptToken(token);
        return this.session.accessToken;
      } catch (error) {
        this.tokenStore.clear();
        this.session = null;
        throw new Error('Twitch token refresh failed; authorize again. ' + error.message);
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
      await this.authorize();
    }
    if (this.session.expiresAt <= Date.now() + 60000) await this.refresh();
    return this.session.accessToken;
  }

  async validate() {
    const token = this.session?.accessToken || await this.getAccessToken();
    const response = await this.fetch(TWITCH_VALIDATE_URL, {
      headers: { Authorization: 'OAuth ' + token }
    });
    if (response.status === 401 && this.session?.refreshToken) {
      await this.refresh();
      return this.validate();
    }
    if (!response.ok) throw new Error('Twitch token validation failed (HTTP ' + response.status + ').');
    const identity = await response.json();
    if (identity.client_id !== this.clientId) throw new Error('Twitch token belongs to a different Client ID.');
    const granted = new Set(identity.scopes || []);
    const missing = this.scopes.filter(scope => !granted.has(scope));
    if (missing.length) throw new Error('Twitch token is missing required scopes: ' + missing.join(', '));
    this.identity = identity;
    return identity;
  }

  async api(path, options = {}, retry = true) {
    const token = await this.getAccessToken();
    const requestBody = options.body;
    const response = await this.fetch('https://api.twitch.tv/helix' + path, {
      ...options,
      ...(requestBody === undefined ? {} : {
        body: typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody)
      }),
      headers: {
        'Client-Id': this.clientId,
        Authorization: 'Bearer ' + token,
        ...(requestBody !== undefined && requestBody !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    if (response.status === 401 && retry) {
      await this.refresh();
      return this.api(path, options, false);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error('Twitch API ' + path + ' failed (HTTP ' + response.status + '): ' + (body.message || 'unknown error'));
      error.status = response.status;
      throw error;
    }
    return body;
  }
}
