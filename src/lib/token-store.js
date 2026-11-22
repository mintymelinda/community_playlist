export class TokenStore {
  constructor(storage = globalThis.sessionStorage, key = 'community-playlist-auth') {
    this.storage = storage;
    this.key = key;
  }

  load() {
    try {
      const value = JSON.parse(this.storage.getItem(this.key) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  save(value) {
    this.storage.setItem(this.key, JSON.stringify(value));
  }

  clear() {
    this.storage.removeItem(this.key);
  }
}
