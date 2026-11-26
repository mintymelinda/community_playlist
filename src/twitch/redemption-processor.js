function isPermanentFailure(error) {
  if ([400, 403, 404].includes(Number(error?.status))) return true;
  return /could not find an available track|unavailable or unplayable|enter a Spotify track/i.test(String(error?.message || ''));
}

export class RedemptionProcessor {
  constructor({
    store,
    spotify,
    coordinator,
    logger = console,
    timers = globalThis,
    retryBaseMs = 1000,
    retryMaxMs = 60000
  }) {
    this.store = store;
    this.spotify = spotify;
    this.coordinator = coordinator;
    this.logger = logger;
    this.timers = timers;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.retryTimers = new Map();
  }

  async accept(redemption) {
    if (!redemption?.id) return false;
    this.logger.info('[community-playlist] Received Twitch redemption.', {
      redemptionId: redemption.id,
      requester: redemption.requester || 'Viewer',
      input: String(redemption.input || '')
    });
    this.store.recordRedemption(redemption);
    return this.process(redemption.id);
  }

  async retryPending() {
    for (const job of this.store.getRetryableRedemptions()) {
      await this.process(job.id);
    }
  }

  async process(id) {
    const job = this.store.claimRedemption(id);
    if (!job) return false;

    if (this.store.containsRequest(id)) {
      this.store.finishRedemption(id, 'queued');
      return true;
    }

    const input = String(job.input || '').trim();
    if (!input) {
      this.store.finishRedemption(id, 'ignored', 'The redemption contained empty song input.');
      this.logger.warn('[community-playlist] Ignored a redemption with empty song input:', id);
      return false;
    }

    try {
      const track = await this.spotify.resolveTrack(input);
      this.logger.info('[community-playlist] Redemption resolved to track.', {
        redemptionId: id, uri: track.uri, title: track.name, isrc: track.isrc || null
      });
      const request = {
        id: job.id,
        uri: track.uri,
        title: track.name,
        artists: track.artists,
        durationMs: track.durationMs,
        isrc: track.isrc || null,
        requester: job.requester,
        requesterId: job.requesterId,
        queuedAt: Date.now()
      };

      try {
        await this.coordinator.enqueue(request);
      } catch (error) {
        if (!this.store.containsRequest(id)) throw error;
        this.logger.warn('[community-playlist] Request was durably queued, but playback needs recovery:', error.message);
      }

      if (!this.store.containsRequest(id)) {
        throw new Error('The request was not present in the persisted playback queue after enqueue.');
      }

      this.clearRetry(id);
      this.store.finishRedemption(id, 'queued');
      this.logger.info('[community-playlist] Queued ' + track.name + ' by ' + track.artists.join(', ') + ' for ' + job.requester + '.');
      return true;
    } catch (error) {
      if (this.store.containsRequest(id)) {
        this.clearRetry(id);
        this.store.finishRedemption(id, 'queued');
        this.logger.warn('[community-playlist] Redemption is already saved in the playback queue; no retry is needed:', id);
        return true;
      }

      if (isPermanentFailure(error)) {
        this.clearRetry(id);
        this.store.finishRedemption(id, 'ignored', error.message);
        this.logger.warn('[community-playlist] Redemption could not be resolved and was rejected:', error.message);
        return false;
      }

      this.store.retryRedemption(id, error.message);
      this.scheduleRetry(id);
      this.logger.error('[community-playlist] Redemption ' + id + ' failed and remains retryable:', error);
      return false;
    }
  }

  scheduleRetry(id) {
    this.clearRetry(id);
    const job = this.store.get().redemptionJobs.find(item => item.id === id);
    if (!job || job.status !== 'pending') return;
    const exponent = Math.min(Math.max(job.attempts - 1, 0), 10);
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    const timer = this.timers.setTimeout(() => {
      this.retryTimers.delete(id);
      return this.process(id).catch(error => {
        this.logger.error('[community-playlist] Redemption retry failed unexpectedly:', error);
      });
    }, delay);
    this.retryTimers.set(id, timer);
  }

  clearRetry(id) {
    const timer = this.retryTimers.get(id);
    if (timer !== undefined) this.timers.clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  dispose() {
    for (const id of this.retryTimers.keys()) this.clearRetry(id);
  }
}
