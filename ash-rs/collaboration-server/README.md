# ash-collaboration-server

- Hosts durable document collaboration and call membership APIs.
- Owns bearer authentication, browser-origin policy, HTTP framing, connection limits and SQLite lifecycle.
- Delegates document ordering to [`ash-collaboration`](../collaboration/README.md) and call authority to [`call`](../call/README.md).
- Manages configured LiveKit rooms through [`livekit-api`](../livekit-api/README.md).
- Has no App Server, workspace, tool, terminal or model execution authority.

## Call media deployment

Configure all four variables on the collaboration host to enable call APIs:

| Variable | Meaning |
| --- | --- |
| `ASH_LIVEKIT_SERVER_URL` | Client-facing `wss://` endpoint, including a custom port when needed |
| `ASH_LIVEKIT_API_URL` | Host-facing `https://` administrative endpoint |
| `ASH_LIVEKIT_API_KEY` | Deployment API key identifier |
| `ASH_LIVEKIT_API_SECRET` | Deployment signing secret, at least 32 bytes |

Loopback development endpoints may use `ws://` and `http://`. These addresses configure LiveKit signaling and administration; public ICE/UDP/TCP/TURN reachability remains part of the user's LiveKit deployment. A signaling port alone is not sufficient to configure a public media service.

Call requests use the existing origin policy and `Cache-Control: no-store`. Creation requires the deployment bearer; other operations require a call member credential. The caller generates and retains each 256-bit hexadecimal member credential before submitting it, so an interrupted request can be retried without issuing a second credential. Persisted credentials are hashed.

| Method/path | JSON request |
| --- | --- |
| `POST /v1/calls/create` | `operationId`, `ownerCredential` |
| `GET /v1/calls/read` | No body |
| `POST /v1/calls/invite` | `operationId`, `revision`, `memberCredential`, `role` |
| `POST /v1/calls/role` | `operationId`, `revision`, `memberId`, `role` |
| `POST /v1/calls/remove` | `operationId`, `revision`, `memberId` |
| `POST /v1/calls/end` | `operationId`, `revision` |
| `POST /v1/calls/join` | `deviceId` |
| `POST /v1/calls/device` | `operationId`, `revision`, `deviceId` |

Mutations and reads return the current call snapshot. Join returns `call`, `member`, `microphone`, `participantId`, `serverUrl`, `participantToken` and `expiresAt` (Unix seconds). Only the member's selected device receives microphone permission; its first speaking-device join selects it atomically. The member can explicitly select another device, which replaces the media room. The member credential authorizes the call API; `participantToken` authorizes only the specified LiveKit room. Creation/invitation retries must reuse the same credential and operation ID; changing parameters under the same operation ID is a conflict. Roles are `owner`, `speaker`, `listener`, `agent`; invitation cannot create another owner, and role changes only switch human speakers/listeners.

Errors contain `error.code` and `error.message`: `invalidInput` (400), `accessDenied` (403), `revisionConflict`/`mediaNotReady` (409), `storageFailure` (500), or `mediaUnavailable` (503). Missing bearer authentication returns 401 through the shared HTTP boundary.

Permission changes replace the media room before new tickets are issued. Pending operations survive restart. The current call coordinator serializes operations within one host process; multi-host media-operation ownership is not implemented. Call notifications, local server process management and product UI are also not implemented. See the [full design and acceptance status](../docs/design/collaboration-media.md).

## Running one host

Run the listener behind a TLS reverse proxy. The binary deliberately accepts
only an IP:port because it does not terminate TLS itself.

```sh
export ASH_COLLABORATION_BEARER_TOKEN='a-random-visible-ascii-token-at-least-32-characters'
export ASH_COLLABORATION_ALLOWED_ORIGIN='https://desktop.example'
cargo run -p ash-collaboration-server -- 127.0.0.1:8421 /srv/ash/collaboration.sqlite3
```

`ASH_COLLABORATION_ALLOWED_ORIGIN` is a comma-separated allowlist. It must
include the exact browser origin serving the Document Engine. The desktop toolbar asks for the
public HTTPS origin and bearer token, then creates or joins a room ID.

The host exposes:

- `POST /v1/document-collaboration/rooms/open`
- `POST /v1/document-collaboration/rooms/submit`
- `GET /v1/document-collaboration/rooms/{roomId}/updates?afterVersion=N`
- `POST /v1/document-collaboration/rooms/presence`
- `GET /v1/document-collaboration/rooms/{roomId}/presence?afterGeneration=N`
- `POST /v1/document-collaboration/rooms/invites`
- `GET /v1/document-collaboration/rooms/{roomId}/members`
- `POST /v1/document-collaboration/rooms/members/rotate-token`
- `POST /v1/document-collaboration/rooms/members/revoke`
- `GET /v1/document-collaboration/rooms/{roomId}/audit`

Every non-preflight request requires `Authorization: Bearer <token>`. The
deployment token bootstraps the persistent `server-admin` room owner; an owner
can issue a room-scoped bearer token for an owner, editor, or viewer. A scoped
token cannot access another room. JSON responses use `Cache-Control: no-store`;
browser requests receive CORS headers only for an allowed origin. `GET updates`
and `GET presence` wait up to 25 seconds when no change is available, then
return a canonical replay or current ephemeral selection set.

Multiple processes can share one SQLite database. A local submission wakes
same-host polls immediately; other hosts recheck persisted state every 250 ms,
so ordered writes and presence do not wait for the 25-second long-poll timeout.

## Current security boundary

The deployment bearer is only a bootstrap credential, not a room share
capability. Room access is enforced through persistent identities and roles;
issued tokens are stored only as SHA-256 hashes and are returned once when
created or rotated. Owner-visible audit events record room creation, member
invitation/revocation, credential rotation, and accepted submissions. The host
validates wire bounds, Document Engine envelopes, generic node/mark/selection structure,
and known core transaction kinds; the active browser profile validates its own
profile-specific schema. Do not expose this endpoint directly to untrusted
networks without TLS, a strong secret, and an origin allowlist.

`cargo test -p ash-collaboration-server` exercises CORS preflight, auth,
room-role enforcement, credential rotation, audit access, presence, ordered
updates, and external updates observed through a second host.
