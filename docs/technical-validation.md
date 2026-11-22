# Phase 1 technical validation

**Status:** documentation review complete; live account validation remains open.

This report records what the current public Twitch and Spotify documentation establishes, what it does not establish, and the experiments required before implementing the playback coordinator. No Twitch or Spotify account was connected and no live playback API calls were made for this report.

## Decisions and constraints

- Keep the application as a single, headless browser page with native JavaScript modules.
- Do not introduce a framework, server, database, or build system without a demonstrated requirement.
- Spotify performs all audio playback. This project does not capture, process, mix, encode, or broadcast audio and does not control OBS.
- Use browser Authorization Code with PKCE. Never ship a client secret.
- Keep diagnostics in the browser console and redact access/refresh tokens, authorization codes, and PKCE material.
- Do not implement the playback coordinator until the interruption/restoration experiment below passes.

## Twitch: Custom Power-up redemption

### What the documentation establishes

Twitch announced the Custom Power-up API and EventSub integration in May 2026. The documented EventSub type is:

- channel.custom_power_up_redemption.add
- Required authorization scope: bits:read
- Transport: EventSub WebSocket is supported.
- The Custom Power-up API can enumerate the broadcaster's configured Power-ups.

Sources:

- [Twitch announcement: API and EventSub support for Custom Power-ups](https://discuss.dev.twitch.com/t/introducing-api-and-eventsub-support-for-custom-power-ups/64708)
- [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types)
- [Managing EventSub subscriptions](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/)

The WebSocket flow starts with a welcome message. Its session ID is used when creating subscriptions. The client must handle notification, keepalive, reconnect, revocation, and close messages. WebSocket subscriptions require a user access token, not an app access token.

Twitch delivers events at least once. A redelivery uses the same EventSub message_id; consumers must deduplicate it. A WebSocket disconnect can create an event-loss window while reconnecting and resubscribing.

Sources:

- [Handling EventSub WebSocket events](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [EventSub overview and duplicate delivery](https://dev.twitch.tv/docs/eventsub)

### What still requires live validation

- Confirm the broadcaster account is eligible to use Custom Power-ups and that the relevant Power-up is visible through the API.
- Confirm the current subscription version and exact condition fields accepted by the live API.
- Capture a real redemption notification and record its event schema, including the Power-up identifier, submitted input, redemption identifier, and user identity.
- Confirm whether the submitted input is present for all relevant redemption paths and how empty/malformed input is represented.
- Verify the bits:read user token can create the WebSocket subscription for the broadcaster.
- Exercise duplicate delivery, reconnect handoff, revocation, and token expiry.

**Implementation gate:** do not hard-code payload field names based solely on analogous Channel Points events. Add a schema fixture from an actual Custom Power-up event before implementing request parsing.

## Spotify: authentication and playback API

### Documented requirements

Spotify's Start/Resume Playback and Add Item to Playback Queue endpoints require Spotify Premium and the user-modify-playback-state scope. The playback-state and queue-read endpoints require read scopes such as user-read-playback-state and user-read-currently-playing.

Relevant endpoints:

- GET /v1/me/player/devices — discover available devices.
- GET /v1/me/player — read current playback state and context.
- GET /v1/me/player/queue — read the current playback queue.
- GET /v1/me/player/currently-playing — read the current item.
- GET /v1/playlists/{playlist_id} and playlist-track endpoints — inspect playlist context and ordering.
- GET /v1/search — resolve text searches to tracks.
- GET /v1/tracks/{id} — inspect track and album metadata.
- PUT /v1/me/player/play — start a context or URI playback.
- POST /v1/me/player/queue — add a track/episode to the current queue.
- POST /v1/me/player/next — skip the current item.

Sources:

- [Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)
- [Add Item to Playback Queue](https://developer.spotify.com/documentation/web-api/reference/add-to-queue)
- [Get User's Queue](https://developer.spotify.com/documentation/web-api/reference/get-queue)
- [OAuth scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)

Spotify explicitly warns that command execution order is not guaranteed when Start/Resume Playback is used with other Player API endpoints. The coordinator must serialize commands and verify the resulting playback state rather than treating a successful HTTP response as proof that the intended track is playing.

### Why Add to Queue is not sufficient

The Add Item to Playback Queue endpoint adds a track or episode to the current queue. It does not offer arbitrary insertion at an index or a corresponding remove-by-ID operation. It therefore cannot, by itself, guarantee that a burst of viewer requests is ordered ahead of every existing item in the queue, nor can it safely undo an incorrect or stale queued request.

The Get User's Queue endpoint now exposes the current queue, but that does not provide a supported arbitrary queue-edit operation. Queue inspection is useful for reconciliation and diagnostics; it is not a substitute for an insertion/removal API.

### Candidate interruption/restoration strategy — NOT YET PROVEN

The current candidate is to keep viewer requests in the browser application's own FIFO queue and use Spotify context playback for each request:

1. Before interrupting, read and snapshot the active device, current playlist context, current track, playlist position, playback position, shuffle/repeat state, and relevant queue state.
2. Derive the next playlist item that should play after the interrupted item. Preserve enough context to restore the configured playlist at that exact item.
3. Start the requested track using its album context and the track URI as the context offset, rather than assuming a bare track-URI play request behaves consistently on every Spotify device.
4. Poll playback state to detect when the requested track has ended or playback has been changed manually. The browser maintains the request FIFO and starts the next request itself.
5. When the request FIFO is empty, resume the original playlist context at the saved next position, restoring playback settings where the API permits.

The Start/Resume Playback endpoint documents both context playback and an offset by track URI or playlist position. This makes the candidate technically plausible, but does not prove that a single-track request can be played without unwanted album continuation, that every target device honours the command, or that restoring a playlist context preserves every aspect of the prior queue.

The album-context approach also has a known concern: if the requested track ends before the controller notices, Spotify may advance within that album. Polling latency, browser background throttling, and device behaviour must be measured. The controller must never claim a track is active based only on a 204 response.

### Required live Spotify experiment

Run this against a real Premium account and the intended Spotify Connect device before writing the coordinator:

1. Start a known playlist with at least four tracks. Record its playlist URI, current track, playlist offset, playback position, shuffle/repeat settings, and the response from Get User's Queue.
2. Start a known request track using a bare uris play request. Confirm whether it plays on the target device.
3. Repeat using the track's album context and an offset URI. Confirm the exact item that plays and what Spotify does when the request track ends.
4. While the request track is playing, issue a second request using the same approach. Measure whether it interrupts reliably.
5. Restore the playlist context at the saved next position. Confirm that the next expected playlist track plays, with no replay of the interrupted track and no loss/reordering of the following tracks.
6. Repeat with an existing manually queued Spotify item, shuffle on/off, repeat modes, a changed active device, and a browser tab in the background.
7. Repeat command sequences with realistic API latency and verify that a 204 response is followed by the expected state in GET /me/player.

Record device model/app, account eligibility, request/response status, observed track sequence, and timing. Do not record bearer tokens or authorization codes.

**Go/no-go:** if the API cannot restore the intended playlist position and preserve the expected sequence across the supported playback configurations, stop and revise the product behaviour before implementing the coordinator. Do not silently fall back to appending viewer requests to the Spotify queue.

## Spotify platform policy boundary

Spotify's Player API reference also carries platform policy notes stating that Spotify content may not be broadcast and that sound recordings may not be synchronized with visual media. This project is explicitly not a live-streaming or broadcasting tool and does not transmit audio, but the optional Now Playing visual could raise a separate synchronization question if it is displayed alongside Spotify playback.

For that reason, keep the controller headless. Do not implement the optional visual display, album artwork, or any audio/visual presentation until the applicable Spotify platform terms have been reviewed for the exact use case. This is a product-policy gate separate from whether the playback API technically works.

Source: [Spotify Start/Resume Playback API policy notes](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).

## OAuth and browser lifecycle

- Spotify browser authorization should use Authorization Code with PKCE; no client secret belongs in the page.
- Twitch EventSub WebSocket subscription creation requires a Twitch user token. Custom Power-up redemption requires bits:read.
- Request only the scopes required for the configured features. Add playback-read scopes only if the selected endpoints require them.
- Access tokens are short-lived. Refresh-token handling must follow the provider's browser-app guidance and be tested for rotation, expiry, revocation, and reconnect. Do not assume every provider issues a refresh token usable by a public browser client.
- Keep secrets out of URLs after callback processing, console output, source control, and persistent configuration.
- Browser storage is accessible to JavaScript running in the same origin. Persistent browser storage is not equivalent to an HttpOnly server session. Avoid persisting long-lived credentials unless the provider's supported public-client flow explicitly requires and permits it.
- The controller must remain open and active to receive WebSocket messages and poll playback state. Browser suspension, tab discard, device sleep, and closed windows can interrupt automation. Recovery must reconcile actual Twitch/Spotify state before replaying any queued request.

A backend is not justified by the current documentation review alone. Revisit that decision only if the supported Twitch/Spotify token lifecycle or reliable background execution cannot be met by a browser-only client.

## Phase 1 exit checklist

- [x] Empty repository initialized with a minimal, dependency-free browser shell.
- [x] Twitch Custom Power-up EventSub type and documented scope identified.
- [x] Twitch WebSocket welcome, subscription, reconnect, and duplicate-delivery requirements documented.
- [x] Spotify Premium requirement, playback scopes, player endpoints, and queue limitation documented.
- [ ] Real Custom Power-up event payload captured and validated.
- [ ] Spotify interruption and playlist restoration experiment completed on the intended device.
- [ ] Browser token lifecycle and background-tab behaviour verified.
- [ ] Final architecture decision recorded before the playback coordinator is implemented.
