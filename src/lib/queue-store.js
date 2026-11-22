const DEFAULT_STATE = Object.freeze({
  pending: [],
  active: null,
  snapshot: null,
  lastRequestUri: null,
  processedRedemptions: [],
  processedMessages: [],
  mode: 'idle',
  lastError: null,
  updatedAt: 0
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class QueueStore {
  constructor(storage = globalThis.localStorage, key = 'community-playlist-v1', maxPending = 100) {
    this.storage = storage;
    this.key = key;
    this.maxPending = maxPending;
    this.state = this.read();
  }

  read() {
    try {
      const saved = JSON.parse(this.storage.getItem(this.key) || 'null');
      if (!saved || typeof saved !== 'object') return clone(DEFAULT_STATE);
      return {
        ...clone(DEFAULT_STATE),
        ...saved,
        pending: Array.isArray(saved.pending) ? saved.pending : [],
        processedRedemptions: Array.isArray(saved.processedRedemptions) ? saved.processedRedemptions : [],
        processedMessages: Array.isArray(saved.processedMessages) ? saved.processedMessages : []
      };
    } catch (error) {
      console.warn('[community-playlist] Saved queue was invalid; starting with an empty queue.', error);
      return clone(DEFAULT_STATE);
    }
  }

  get() {
    return clone(this.state);
  }

  update(mutator) {
    const next = clone(this.state);
    mutator(next);
    if (next.pending.length > this.maxPending) {
      throw new Error('The request queue is full. The new request was not added.');
    }
    next.processedRedemptions = next.processedRedemptions.slice(-1000);
    next.processedMessages = next.processedMessages.slice(-1000);
    next.updatedAt = Date.now();
    this.storage.setItem(this.key, JSON.stringify(next));
    this.state = next;
    return this.get();
  }

  rememberRedemption(id) {
    if (!id) return false;
    if (this.state.processedRedemptions.includes(id)) return false;
    this.update(state => state.processedRedemptions.push(id));
    return true;
  }

  rememberMessage(id) {
    if (!id) return true;
    if (this.state.processedMessages.includes(id)) return false;
    this.update(state => state.processedMessages.push(id));
    return true;
  }

  enqueue(request) {
    if (this.state.pending.length >= this.maxPending) return false;
    this.update(state => state.pending.push(request));
    return true;
  }

  clear() {
    this.state = clone(DEFAULT_STATE);
    this.storage.removeItem(this.key);
  }
}

export class MemoryStorage {
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
