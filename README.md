# Community Playlist

A headless browser controller that listens for Twitch Custom Power-up song requests and plays them before the upcoming tracks in the broadcaster's existing Spotify playlist.

Spotify itself handles all audio playback. This project does not capture, process, mix, encode, or transmit audio. It has no visible interface and no OBS or broadcast controls.

## Implemented

- Twitch public-client Device Code authorization, token validation, one-time refresh-token rotation, and reconnect handling.
- Automatic discovery of the broadcaster's Custom Power-ups; selects the only enabled, in-stock text-input Power-up or requires an explicit ID if several are available.
- Twitch EventSub WebSocket subscriptions for Custom Power-up redemptions and chat messages, including keepalive, session migration, reconnect, and duplicate-delivery handling.
- Spotify Authorization Code with PKCE, token refresh, device selection, playlist inspection, Spotify track URL/URI parsing, and text search.
- Persistent application-owned FIFO request queue, retryable redemption intake, request-ID idempotency, serialized playback changes, and conservative browser-reload recovery.
- Broadcaster/moderator-only \`!skip\`, advancing directly to the next viewer request without calling Spotify's playlist skip endpoint.
- Playback safeguards for manual queue entries, shuffle/repeat, changed devices, manual playback changes, duplicate playlist tracks, unavailable playlist items, and unexpected playlist edits.
- Automated tests for OAuth-related helpers, Twitch redemption/chat authorization, retry and duplicate-delivery handling, EventSub reconnect/migration/keepalive lifecycle, request ordering, skip behaviour, storage recovery, Spotify parsing, and playlist restore-position resolution.

## Requirements

- A Twitch broadcaster account eligible for Custom Power-ups (Twitch documents that the API is available to Partners and Affiliates).
- At least one enabled, in-stock Twitch Custom Power-up that requires viewer text input.
- A Spotify Premium account.
- A Spotify playlist the authenticated user can read (the configured account should own or collaborate on private playlists).
- A static HTTPS host and a browser tab that remains open while requests are being handled.
- Node.js 22 or newer for development. No runtime or development dependencies are required.

## Setup

1. Register a Twitch application as a **public client**. The controller uses Device Code authorization and requests only \`bits:read\` and \`user:read:chat\`. Authorize with the broadcaster's Twitch account.
2. Register a Spotify app. Add the exact URL serving \`index.html\` to its redirect URI allowlist.
3. Copy \`config.example.js\` to \`config.local.js\`. Set the Twitch and Spotify client IDs, exact Spotify redirect URI, and Spotify playlist URI. Leave \`broadcasterId\` blank to use the Twitch-authorized account. Leave \`powerUpId\` blank only when exactly one enabled text-input Power-up exists; otherwise set its ID.
4. Host the files from a static HTTPS origin. Do not open the page as a \`file://\` URL. Keep \`config.local.js\` on the same origin as the application and do not commit it.
5. Open the page in the browser tab that will remain active. Open the browser developer console and run \`communityPlaylist.start()\`. Spotify authorization redirects the current tab to Spotify and returns to the configured page. Twitch Device Code authorization then prints a one-time verification URL and code to the console; enter the code at that URL.
6. Open Spotify on the intended Connect device and start the configured playlist. Turn shuffle and repeat off. Requests are accepted only while the configured playlist is playing on the selected device.

Example local configuration:

\`\`\`js
export default {
  twitchClientId: 'your-twitch-public-client-id',
  spotifyClientId: 'your-spotify-client-id',
  spotifyRedirectUri: 'https://example.com/community-playlist/',
  playlistUri: 'spotify:playlist:yourPlaylistId',
  broadcasterId: '',
  powerUpId: '',
  spotifyDeviceId: '',
  pollIntervalMs: 2000,
  maxPendingRequests: 100
};
\`\`\`

The redirect URI must exactly match the URL serving \`index.html\`, including path and trailing slash. The Spotify account must be able to read the configured playlist items.

## Runtime

The page is intentionally blank. Diagnostics are written to the browser console. Once started, these console commands are available:

\`\`\`js
communityPlaylist.status()
communityPlaylist.stop()
communityPlaylist.resume()
\`\`\`

The controller must remain open and the browser must continue executing the tab. Browser shutdown, tab discard, device sleep, or suspended execution can delay request handling. Queue state, processed redemption IDs, and retryable redemption intake records are stored in \`localStorage\`; Twitch/Spotify access and refresh tokens plus the Spotify PKCE verifier are stored in \`sessionStorage\`. A redemption is saved before Spotify lookup, transient failures are retried with bounded exponential backoff, and interrupted processing is recovered after reload. Request IDs are checked against active and pending playback entries to prevent duplicate insertion. Closing the tab clears those session tokens and requires authorization again.

\`stop()\` closes EventSub and stops playback polling. It deliberately does not pause Spotify or alter the current track. \`resume()\` is available after a manual playback change has put the queue into handoff mode; it requires the configured playlist to be playing again.

## Playback behaviour and safeguards

The controller does not append viewer requests to Spotify's queue. Requests are held in a separate FIFO queue and played as individual Spotify track URIs. Before the first request, it records the active device and playlist context, resolves the next playlist offset by comparing the playlist's items with Spotify's upcoming queue, and verifies the expected track after every playback command.

It refuses to interrupt unless:

- The configured playlist is actively playing on the selected device.
- Shuffle and repeat are off.
- The current track maps to one unambiguous position in the playlist.
- The upcoming queue matches the playlist continuation.
- The playlist has no unavailable or unsupported entries that would make positional restoration unsafe.

After the viewer FIFO is exhausted, it restores the playlist at the saved next offset. If Spotify has already returned to that exact next item, it leaves playback alone. A moderator skip starts the next viewer request directly; it does not call Spotify's skip-next endpoint, which could skip a playlist track.

If the device changes or unrelated manual playback is detected, the controller stops taking over, preserves unplayed requests, and enters handoff mode. It never pauses or rewrites the user's playlist.

**Important limitation:** Spotify does not expose the active playlist offset directly, and API success responses do not prove the intended item is playing. This controller infers the position using the playlist items and upcoming queue, verifies the actual track after commands, and restores by playlist context plus offset. These behaviours have mock-based tests but still require verification on the actual Premium account and Connect device. Browser throttling or loss of the active tab can still delay polling enough to affect the exact transition timing.

Spotify's platform terms prohibit broadcasting Spotify content and synchronizing sound recordings with visual media. This app remains headless and has no audio or visual rendering path; it must not be used to pipe Spotify audio into a broadcast or to synchronize Spotify recordings with an overlay.

## Live-account E2E test environment

The local E2E runner uses the same Twitch/Spotify OAuth implementations and the real Spotify Web API/Connect device. It serves the application only on `127.0.0.1`; the generated browser config contains public client IDs and test settings only. **Do not put Twitch or Spotify client secrets, access tokens, refresh tokens, or authorization codes in `.env.e2e`.** The runner ignores secret/token environment variables rather than forwarding them.

1. Copy `.env.e2e.example` to `.env.e2e`.
2. Set `TWITCH_CLIENT_ID`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_PLAYLIST_URI`, `E2E_TRACK_X`, and `E2E_TRACK_Y`. Use two different Spotify track URIs or URLs for X and Y. Optional broadcaster, Power-up, and Connect device IDs can also be set.
3. Add the exact redirect URI `http://127.0.0.1:4173/` to the Spotify app's redirect URI allowlist. Do not substitute `localhost`; Spotify's loopback redirect requires an explicit IP literal. The runner defaults to port 4173. If you change `PORT`, change `SPOTIFY_REDIRECT_URI` to the exact matching `http://127.0.0.1:PORT/` value.
4. Use a disposable browser profile. Start the test server with `npm run e2e:serve`, then open `http://127.0.0.1:4173/`.
5. Open the browser developer console and run `communityPlaylist.start()`. Complete Spotify PKCE authorization and the Twitch Device Code flow. These flows happen directly between the browser and their providers; the local server does not receive or persist OAuth tokens.
6. On the target Spotify Connect device, play the configured playlist with shuffle and repeat off. Choose X and Y so neither is the currently playing song nor the playlist track that should resume next. Make sure the playlist has at least one upcoming track.
7. Run `await communityPlaylist.e2e.preflight()`, then `await communityPlaylist.e2e.runPlaybackSequence()`.

The automated live sequence uses synthetic Twitch notification objects passed through the application's EventSub notification handler, so it does not spend Bits. It performs real Spotify track resolution and playback commands, checks that X then Y play, verifies that an unauthorized `!skip` is ignored, checks broadcaster `!skip`, confirms the playlist resumes at the exact saved next track, and verifies that the playlist items were not modified. This exercises the Spotify Connect device and coordinator, but it does not prove Twitch delivered a real notification.

To validate the real Twitch redemption transport separately, run `await communityPlaylist.e2e.waitForRealRedemption()` and then redeem the configured Custom Power-up on the broadcaster's channel. This is a real redemption and may spend Bits. The method waits for the redemption to be processed by the live EventSub connection.

E2E mode uses separate `sessionStorage` token keys and a separate `localStorage` request queue. It is enabled only on the local `http://127.0.0.1` origin. The local server binds only to loopback, serves only the application JavaScript and HTML plus generated `config.local.js`, disables caching, and does not log request URLs. The `.env.e2e` file is ignored by Git. Do not share browser HAR files, profile directories, or console dumps containing OAuth codes or tokens.

If a test is interrupted after a Spotify command, the harness enters the coordinator's safe handoff mode and preserves remaining requests rather than blindly issuing another play or restore command. Inspect `communityPlaylist.status()` before using `communityPlaylist.resume()`.

## Development

There are no dependencies to install. Run:

\`\`\`sh
npm run check
npm test
npm run verify
\`\`\`

See [the roadmap issue](https://github.com/mintymelinda/community_playlist/issues/1) and [technical validation notes](docs/technical-validation.md) for the remaining real-account/device verification.
