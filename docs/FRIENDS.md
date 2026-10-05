# Friends and invites — LOCAL TESTED (workerd), BROWSER VERIFIED (Chromium)

* **Request** `POST /api/friends/requests {username}` → `pending`. Asking someone who already asked you accepts both. Refused
  requests can be re-sent; self-requests, unknown users, duplicates and existing friends are rejected.
* **Accept / refuse** `POST /api/friends/requests/:id/accept|refuse` — only the recipient (anyone else gets 404). **Cancel**
  `DELETE /api/friends/requests/:id` by the sender. **Remove** `DELETE /api/friends/:userId` (both directions; voids pending invites).
* Friendships are one row per pair (`user_a < user_b`). Every change is pushed live to the other user's devices over the presence socket
  (`friend_request`, `friend_update`).

## Invites
`POST /api/invites {friendId, gameId}` requires: friendship, your own ready game, the friend **ONLINE** (not OFFLINE → `friend_offline`,
not IN_GAME → `friend_busy`). TTL 2 minutes. The invitee sees *"<displayName> ti invita a giocare a <titolo>"* with **ACCETTA / RIFIUTA**.
Accepting creates a session ([CLOUD.md](CLOUD.md)): Player 1 = inviter (owns the game, has the cartridge), Player 2 = invitee (no
cartridge), a GameSession Durable Object, the container boots and both browsers are sent to the game screen. Expired, double-answered,
foreign and cancelled invites are rejected with 410/409/404.

## Tests
`friends.test.ts` (9, with presence) and `session.test.ts` (14: invite flow, refuse, guards, busy friend, cancel, authorisation) plus
the PWA flow in `pwa_e2e.mjs` (request, live accept, invite text and buttons).
