# Community Playlist

A headless browser-based controller that listens for Twitch Custom Power-up song requests and temporarily prioritizes them in a broadcaster's existing Spotify playback.

Spotify handles all audio playback. This project does not capture, process, mix, encode, or broadcast audio, and it does not control OBS.

The application is intentionally UI-free. A read-only Now Playing display may be added later as an optional feature.

## Status

The project is in Phase 1: repository foundation and technical validation. See the [roadmap issue](https://github.com/mintymelinda/community_playlist/issues/1) and [the Phase 1 technical validation report](docs/technical-validation.md).

The report separates documented API behaviour from unverified assumptions. In particular, the Spotify playlist interruption/restoration strategy is not yet proven against a real account and device.

## Constraints

- Browser-only JavaScript unless a concrete platform limitation requires a backend.
- OAuth Authorization Code with PKCE; no embedded client secrets.
- Minimum OAuth scopes and no secrets in source control or logs.
- Separate FIFO request handling; never assume Spotify's queue supports arbitrary insertion or removal.
- No audio pipeline, streaming/broadcasting features, OBS integration, or general-purpose dashboard.
