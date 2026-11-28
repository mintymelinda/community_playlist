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
2. Requires repeat mode to be off while accepting requests.
3. Reads the playlist items and Spotify's upcoming queue.
4. Maps Spotify's upcoming queue to one unambiguous playlist continuation. With shuffle off, matches the queue sequence against the playable playlist sequence; with shuffle on, maps the first upcoming item to its unique playlist offset and verifies that queued items belong to the playlist. The current track URI narrows the match when present, but is not required if the queue independently identifies a unique continuation.
5. Refuses to take over if the upcoming queue cannot be mapped, duplicate-track ambiguity remains, shuffled queue data is missing, or manual queue entries fall outside the configured playlist. A current URI that does not appear in the playlist is acceptable only when the upcoming queue independently establishes a unique continuation. Unavailable/local playlist entries are retained as positional placeholders and skipped only when the upcoming queue confirms the next playable item.

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

The automated suite covers parsing, authorization decisions, retryable redemption processing, concurrent duplicate delivery, queue idempotency, EventSub session migration/reconnect/keepalive/stop, playback sequencing, and restoration safeguards. Live Spotify playback and real Twitch redemption delivery must be validated separately against the intended accounts and Connect device. Background-tab throttling and browser-reload recovery also remain separate tests.

- [x] Minimal headless browser entry point.
- [x] OAuth implementations for Twitch Device Code and Spotify PKCE.
- [x] Twitch redemption and chat EventSub subscriptions.
- [x] Separate FIFO queue, duplicate suppression, moderator-only skip, and recovery safeguards.
- [x] Spotify request resolution, playback state polling, and playlist offset restoration implementation.
- [x] Automated unit tests for parsing, authorization decisions, retryable redemption processing, concurrent duplicate delivery, queue idempotency, EventSub lifecycle, playback sequencing, and restoration safeguards.
- [ ] Real broadcaster Custom Power-up redemption payload and delivery verified against a live channel.
- [ ] Live Spotify Premium interruption, FIFO request playback, skip, playlist restoration, and playlist non-mutation verified on the configured Connect device.
- [ ] Background-tab and browser-reload timing tested on the intended browser.


### Playback confirmation

Spotify's play endpoint can accept a command before the current-playback endpoint reflects the new item. The coordinator therefore polls for up to 20 seconds (at 400 ms intervals by default), requiring the exact requested track URI on the target Connect device. Transient player-state API errors are retried within that bounded confirmation window. A timeout reports the last observed track and device for diagnosis; it does not assume playback succeeded.
