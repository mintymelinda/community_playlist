# Technical validation and known limits

## Twitch

The controller uses:

- \`channel.custom_power_up_redemption.add\`, EventSub version \`1\`, scoped to the broadcaster and the selected Custom Power-up.
- \`channel.chat.message\`, version \`1\`, with the broadcaster as the chat reader.
- Twitch Device Code authorization as a public client. Access tokens are validated before use and refresh tokens are rotated immediately because Twitch Device Code refresh tokens are single-use.

The API identifies Custom Power-ups with \`GET /helix/bits/custom_power_ups?broadcaster_id=...\`. The controller selects an enabled, in-stock Power-up with \`is_user_input_required=true\`; when more than one exists, configuration must identify the correct Power-up. The redemption payload provides \`event.user_input\`, the redemption ID, user information, and Custom Power-up ID. Canceled redemptions are ignored; other statuses are treated as redemptions.

Redemptions are journaled before track resolution with \`pending\`, \`processing\`, \`queued\`, and \`ignored\` states. Transient Spotify/network failures return to \`pending\` and retry with bounded exponential backoff. On browser reload, interrupted \`processing\` records are recovered as \`pending\`. Queue insertion checks the redemption ID against both active and pending requests, preventing retries from inserting the same request twice. Chat message IDs remain separately deduplicated. Chat \`!skip\` is accepted only when the chatter is the broadcaster or Twitch's event badges include the moderator/broadcaster badge. Usernames are not trusted for authorization.

Sources:

- [Get Custom Power-up](https://dev.twitch.tv/docs/api/reference/bits)
- [Custom Power-up redemption EventSub](https://dev.twitch.tv/docs/eventsub/reference/channel)
- [Channel chat message EventSub](https://dev.twitch.tv/docs/eventsub/reference/chat)
- [Twitch Device Code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Twitch EventSub WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)

## Live-account end-to-end environment

A no-dependency local runner is available through `npm run e2e:serve`. Copy `.env.e2e.example` to the ignored `.env.e2e` file and populate only the Twitch/Spotify public client IDs, playlist URI, and two test-track URIs/URLs. Never store client secrets, access tokens, refresh tokens, or authorization codes in this file. The server uses an explicit environment allowlist, binds only to `127.0.0.1`, serves the app's root page and source JavaScript plus an in-memory `config.local.js`, and disables caching. E2E tokens are created by the normal Spotify PKCE and Twitch Device Code browser flows, held in isolated E2E `sessionStorage` keys, and never sent to the local server.

Spotify's registered redirect URI must be exactly `http://127.0.0.1:4173/` for the default port (or the matching loopback IP and port if `PORT` is changed). Spotify requires loopback redirects to use an explicit IP literal rather than `localhost`; see the [Spotify redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri) and [PKCE guide](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow). Twitch Device Code authorization is designed for public clients and does not require a client secret; see [Twitch OAuth token documentation](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).

Start the server, open the loopback URL in a disposable browser profile, and run `communityPlaylist.start()`. With the configured playlist playing on the target Connect device (repeat off; shuffle may be on), run:

```js
await communityPlaylist.e2e.preflight()
await communityPlaylist.e2e.runPlaybackSequence()
```

This sequence synthesizes Twitch notification payloads at the connected EventSub handler boundary, but uses actual Spotify search/track lookup, player state, playback commands and queue reads. It verifies request X then Y, unauthorized skip rejection, broadcaster skip, restoration to the exact saved next playlist track, and no playlist mutation. It does not validate delivery of a real Twitch notification. The browser suite also exposes `verifyProviderTokenRefresh()`, which forces real Twitch and Spotify refresh-token grants and validates API access without displaying token values, and `verifyEventSubReconnect()`, which closes the active WebSocket, waits for a new session, and queries Twitch to confirm both subscriptions are enabled on that session.

For real Twitch transport validation, call `await communityPlaylist.e2e.waitForRealRedemption()` and then redeem the configured Custom Power-up. This is a real redemption and may spend Bits. To exercise actual chat EventSub delivery and permissions, call `await communityPlaylist.e2e.runRealChatSkipTest()`; it prompts for an unauthorized viewer `!skip` followed by a broadcaster/moderator `!skip`, and verifies both effects against live Spotify playback. The local E2E queue and OAuth session namespace are distinct from normal browser app storage.

The test harness is safety-first: if playback validation fails after the sequence has started, it enters handoff and preserves remaining requests rather than attempting an unverified restoration. Inspect the current status and manually re-establish the configured playlist before invoking `communityPlaylist.resume()`.

## GitHub Actions live E2E

`.github/workflows/live-e2e.yml` is manually dispatched and runs the live integration suite in headless Chromium. It has two stages because Spotify PKCE redirects to the user's browser while the runner must retain the corresponding code verifier:

1. **`authorize_spotify`** generates a PKCE verifier/state and authorization URL. The verifier is AES-256-GCM encrypted with `SPOTIFY_PKCE_HANDOFF_KEY` and uploaded as a one-day Actions artifact. The key is configured once as a repository Actions secret; the artifact is encrypted because users with repository read access can download Actions artifacts.
2. **`run_live_test`** accepts the numeric run ID from stage 1 and the complete Spotify callback URL. CI downloads/decrypts the artifact, validates state and redirect URI, and exchanges the authorization code using the PKCE verifier. The callback URL is masked in workflow logs.
3. CI starts Twitch Device Code authorization with the public `TWITCH_CLIENT_ID`, prints the Twitch activation URL/code, polls until the broadcaster approves, and validates the account and scopes. Twitch tokens and Spotify tokens are kept in the ephemeral runner and browser memory only.

Configure non-secret configuration as repository Actions variables: `TWITCH_CLIENT_ID`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_PLAYLIST_URI`, `E2E_TRACK_X`, `E2E_TRACK_Y`, and optional `TWITCH_BROADCASTER_ID`, `TWITCH_POWER_UP_ID`, and `SPOTIFY_DEVICE_ID`. For migration compatibility, the live-test job uses the legacy `TWITCH_CLIENT_ID` secret only when the same variable is absent; move it to Variables and remove the duplicate Secret. The Spotify playlist accepts a bare 22-character ID, URI, or URL; each test track accepts a bare 22-character ID, URI, or URL and is normalized to a typed URI. `SPOTIFY_CLIENT_ID` must be the Web API OAuth Client ID from the Spotify Developer Dashboard app settings, not a Spotify Soloist `spak_` API key. A Soloist key is sensitive; never store it in Actions Variables or paste it into this project, and revoke/rotate it if exposed. This controller does not use Soloist keys. The only long-term Actions secret is `SPOTIFY_PKCE_HANDOFF_KEY`. Register Spotify redirect URI `http://127.0.0.1:4173/`. Configure the single Actions secret `SPOTIFY_PKCE_HANDOFF_KEY` with a base64-encoded 32-byte random key. No provider access tokens, refresh tokens, or client secrets are stored in GitHub.

In the first workflow run, select stage `authorize_spotify`, open the authorization URL from the run summary, and approve access. Copy the complete redirect URL from the browser address bar (the local page may fail to load). In a second run, select `run_live_test`, provide the first run's numeric ID and the complete callback URL. The Spotify authorization code is short-lived, so dispatch the second run promptly. The CI log/summary then provides Twitch Device Code instructions; approve with the broadcaster account and the test continues automatically.

The default run verifies live preflight, real Spotify X → Y playback and restore, unauthorized skip rejection, broadcaster skip, no playlist mutation, and Twitch EventSub reconnection. Its redemption notifications are synthetic and spend no Bits. The optional `run_real_chat_test` waits for actual viewer and broadcaster/moderator `!skip` messages. It does not redeem a real Custom Power-up.

The Spotify Connect device must be online and playing the configured playlist, with repeat off and an upcoming playlist track. Shuffle may be enabled. X and Y must be distinct from one another, the current track, and the exact next item shown in Spotify's upcoming queue. A failure after playback takeover may require manual playlist recovery. GitHub Actions concurrency prevents overlapping live test runs.

## Spotify

The controller uses Authorization Code with PKCE and the scopes:

- \`user-read-playback-state\`
- \`playlist-read-private\`
- \`playlist-read-collaborative\`
- \`user-modify-playback-state\`

Playback control requires Spotify Premium. Playlist reading uses the current \`GET /playlists/{id}/items\` route; its items can be tracks or episodes, and the older \`/tracks\` playlist route is deprecated in the 2026 API changelog. Spotify Search uses a limit of one result, within the current documented maximum of ten.

Sources:

- [Spotify PKCE authorization](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)
- [Get User's Queue](https://developer.spotify.com/documentation/web-api/reference/get-queue)
- [Get Playlist Items and February 2026 migration notes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)

## Interruption and restoration strategy

Viewer requests are not appended to Spotify's queue. They are stored locally and serialized through an application-owned FIFO. Before taking over playback, the coordinator:

1. Confirms the configured playlist is actively playing on the intended device.
2. Requires repeat mode to be off; shuffle may remain enabled.
3. Reads the playlist items and Spotify's upcoming queue.
4. When shuffle is off, matches the current track and upcoming queue against the sequential playlist continuation. When shuffle is on, maps Spotify's first upcoming track to its unique playlist offset and verifies that the reported queue entries belong to the playlist.
5. Refuses to take over if the current or upcoming item cannot be mapped, duplicate-track ambiguity remains, shuffled queue data is missing, or manual queue entries fall outside the configured playlist. Unavailable/local playlist entries are retained as positional placeholders and skipped only when the upcoming queue confirms the next playable item.

It then starts each request as a single URI, verifies the resulting current track, and watches playback state. When the request queue empties, it restores the saved playlist context at the saved offset, rather than calling Spotify's next endpoint.

This is a conservative candidate strategy, not a proven guarantee. Spotify does not expose the current playlist offset directly, command execution order is not guaranteed across Player API endpoints, and browser polling can be throttled or suspended. A real Spotify Premium account and target Connect device must be used to confirm the exact sequence and timing before relying on the controller in routine use.

### Required real-device test

1. Play a playlist with at least four tracks and record the current track, the next three queue entries, device ID, shuffle/repeat settings, and playback state. Repeat the test with shuffle both off and on; repeat mode must remain off.
2. Redeem a request while track A is playing; confirm request X becomes the current item.
3. Redeem a second request while X is playing; confirm it is queued locally and does not mutate Spotify's playlist or queue.
4. Allow X to finish or issue authorized \`!skip\`; confirm Y plays next.
5. Finish/skip Y; confirm playlist track B plays, not A or C.
6. Repeat with shuffle enabled, a manually queued Spotify track, duplicate playlist entries, a device change, browser background throttling, temporary network loss, and tab reload.
7. Confirm a manual pause does not advance the application queue and manual playback changes trigger handoff instead of controller takeover.

Record only the device type, playback sequence, response codes, and timing. Never record access tokens, refresh tokens, authorization codes, or PKCE values.

## Security and lifecycle

- No client secrets are embedded in the browser.
- OAuth state and PKCE verifiers are held in \`sessionStorage\`.
- Access and refresh tokens are held in \`sessionStorage\`; this reduces persistence but is not equivalent to HttpOnly cookies. Same-origin JavaScript can still access them.
- Operational queue and deduplication state use \`localStorage\`; no credentials are stored there.
- There are no third-party scripts or runtime dependencies.
- EventSub WebSocket messages are handled in the browser tab. If the tab is suspended or closed, event intake and playback polling stop.
- On reload, an active request is reconciled against actual Spotify playback. If the controller cannot prove what is playing, it preserves pending requests and enters handoff mode rather than issuing potentially destructive playback commands.

## Spotify platform policy

Spotify's current Player API policy notes state that Spotify content may not be broadcast and sound recordings may not be synchronized with visual media. This implementation contains no audio capture, output, mixing, visualizer, Now Playing display, or OBS integration. Do not route Spotify content into a broadcast or synchronize it with an overlay. This is separate from technical API behaviour.

Source: [Spotify Start/Resume Playback policy notes](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).

## Current validation status

- [x] Minimal headless browser entry point.
- [x] OAuth implementations for Twitch Device Code and Spotify PKCE.
- [x] Twitch redemption and chat EventSub subscriptions.
- [x] Separate FIFO queue, duplicate suppression, moderator-only skip, and recovery safeguards.
- [x] Spotify request resolution, playback state polling, and playlist offset restoration implementation.
- [x] Automated tests for parsing, authorization decisions, retryable redemption processing, concurrent duplicate delivery, queue idempotency, EventSub session migration/reconnect/keepalive/stop, playback sequencing, and restoration safeguards.
- [ ] Real broadcaster Custom Power-up payload verified against a live channel.
- [ ] Real Spotify Premium interruption/restoration sequence verified on the target Connect device.
- [ ] Background-tab and browser-reload timing tested on the intended browser.
