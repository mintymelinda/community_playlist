import { normalizePlaylistItem, normalizeSpotifyTrack, parseSpotifyTrackInput } from '../lib/spotify-track.js';

export class SpotifyClient {
  constructor({ auth, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  async api(path, { method = 'GET', body } = {}, retry = true) {
    const token = await this.auth.getAccessToken();
    const response = await this.fetch('https://api.spotify.com/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    if (response.status === 401 && retry && this.auth.session?.refreshToken) {
      await this.auth.refresh();
      return this.api(path, { method, body }, false);
    }
    if (response.status === 429 && retry) {
      const seconds = Math.min(30, Math.max(1, Number(response.headers.get('Retry-After')) || 2));
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      return this.api(path, { method, body }, false);
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error('Spotify API ' + path + ' failed (HTTP ' + response.status + '): ' + (data.error?.message || data.error_description || 'unknown error'));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  getDevices() {
    return this.api('/me/player/devices').then(result => result?.devices || []);
  }

  getPlaybackState() {
    return this.api('/me/player');
  }

  resumePlayback(deviceId) {
    const query = deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '';
    return this.api('/me/player/play' + query, { method: 'PUT' });
  }

  setShuffle(enabled, deviceId) {
    const params = new URLSearchParams({ state: String(Boolean(enabled)) });
    if (deviceId) params.set('device_id', deviceId);
    return this.api('/me/player/shuffle?' + params, { method: 'PUT' });
  }

  setRepeat(mode, deviceId) {
    if (!['off', 'track', 'context'].includes(mode)) {
      throw new Error('Spotify repeat mode must be off, track, or context.');
    }
    const params = new URLSearchParams({ state: mode });
    if (deviceId) params.set('device_id', deviceId);
    return this.api('/me/player/repeat?' + params, { method: 'PUT' });
  }

  getQueue() {
    return this.api('/me/player/queue').then(result => result?.queue || []);
  }

  async getPlaylistItems(playlistId) {
    const items = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total && offset < 10000) {
      const page = await this.api('/playlists/' + encodeURIComponent(playlistId) + '/items?limit=50&offset=' + offset);
      const batch = Array.isArray(page?.items) ? page.items : [];
      items.push(...batch.map(normalizePlaylistItem));
      total = Number(page?.total) || 0;
      offset += batch.length;
      if (!batch.length) break;
    }
    if (offset < total) throw new Error('The playlist is too large to safely map its current playback position.');
    return items;
  }

  async resolveTrack(input) {
    const parsed = parseSpotifyTrackInput(input);
    if (parsed) {
      const track = await this.api('/tracks/' + encodeURIComponent(parsed.id));
      const normalized = normalizeSpotifyTrack(track);
      if (!normalized) throw new Error('The supplied Spotify track is unavailable or unplayable.');
      return normalized;
    }

    const query = String(input || '').trim();
    if (!query) throw new Error('Enter a Spotify track link or a song title and artist.');
    const result = await this.api('/search?' + new URLSearchParams({
      q: query,
      type: 'track',
      limit: '1'
    }));
    const track = result?.tracks?.items?.[0];
    const normalized = normalizeSpotifyTrack(track);
    if (!normalized) throw new Error('Spotify could not find an available track for: ' + query);
    return normalized;
  }

  playTrack(uri, deviceId) {
    const query = deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '';
    return this.api('/me/player/play' + query, {
      method: 'PUT',
      body: { uris: [uri] }
    });
  }

  playPlaylistAt(playlistUri, offset, deviceId) {
    const query = deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '';
    return this.api('/me/player/play' + query, {
      method: 'PUT',
      body: {
        context_uri: playlistUri,
        offset: { position: offset },
        position_ms: 0
      }
    });
  }

  extractPlaylistId(uri) {
    const value = String(uri || '').trim();
    const match = value.match(/(?:spotify:playlist:|open\.spotify\.com\/playlist\/)([A-Za-z0-9]+)/i);
    if (!match) throw new Error('Configure playlistUri as a Spotify playlist URI or URL.');
    return match[1];
  }
}
