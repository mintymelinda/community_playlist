const DEFAULT_STATE = Object.freeze({
  pending: [],
  active: null,
  snapshot: null,
  lastRequestUri: null,
  processedRedemptions: [],
  redemptionJobs: [],
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
        redemptionJobs: Array.isArray(saved.redemptionJobs)
          ? saved.redemptionJobs.map(job => job?.status === 'processing'
            ? { ...job, status: 'pending', lastError: 'Recovered an interrupted redemption; it will be retried.' }
            : job)
          : [],
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
    const unresolved = next.redemptionJobs.filter(job => job.status === 'pending' || job.status === 'processing');
    const settled = next.redemptionJobs.filter(job => job.status !== 'pending' && job.status !== 'processing').slice(-1000);
    next.redemptionJobs = [...unresolved, ...settled];
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

  recordRedemption(redemption) {
    if (!redemption?.id) return false;
    if (this.state.processedRedemptions.includes(redemption.id)) return false;
    if (this.state.redemptionJobs.some(job => job.id === redemption.id)) return false;
    this.update(state => {
      state.redemptionJobs.push({
        id: redemption.id,
        input: String(redemption.input || ''),
        requester: redemption.requester || 'Viewer',
        requesterId: redemption.requesterId || null,
        status: 'pending',
        attempts: 0,
        lastError: null,
        updatedAt: Date.now()
      });
    });
    return true;
  }

  claimRedemption(id) {
    const job = this.state.redemptionJobs.find(item => item.id === id);
    if (!job || job.status !== 'pending') return null;
    this.update(state => {
      const current = state.redemptionJobs.find(item => item.id === id);
      current.status = 'processing';
      current.attempts += 1;
      current.updatedAt = Date.now();
      current.lastError = null;
    });
    return this.get().redemptionJobs.find(item => item.id === id) || null;
  }

  finishRedemption(id, status, error = null) {
    const job = this.state.redemptionJobs.find(item => item.id === id);
    if (!job) return false;
    this.update(state => {
      const current = state.redemptionJobs.find(item => item.id === id);
      current.status = status;
      current.lastError = error ? String(error) : null;
      current.updatedAt = Date.now();
      if (status === 'queued' || status === 'ignored') {
        state.processedRedemptions.push(id);
      }
    });
    return true;
  }

  retryRedemption(id, error) {
    const job = this.state.redemptionJobs.find(item => item.id === id);
    if (!job || job.status !== 'processing') return false;
    return this.finishRedemption(id, 'pending', error);
  }

  getRetryableRedemptions() {
    return this.get().redemptionJobs.filter(job => job.status === 'pending');
  }

  containsRequest(id) {
    if (!id) return false;
    return this.state.active?.id === id || this.state.pending.some(request => request.id === id);
  }

  rememberMessage(id) {
    if (!id) return true;
    if (this.state.processedMessages.includes(id)) return false;
    this.update(state => state.processedMessages.push(id));
    return true;
  }

  enqueue(request) {
    if (request?.id && this.containsRequest(request.id)) return false;
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
