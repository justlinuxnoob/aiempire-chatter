# Fanvue API notes

What this project relies on, verified against the official docs
([api.fanvue.com/docs](https://api.fanvue.com/docs)) and a real creator account (Oct 2026).

## Auth

- App: [fanvue.com/developers/apps](https://www.fanvue.com/developers/apps), creator account with KYC only. Private apps need no review or listing.
- OAuth 2.0 + **PKCE (S256, required)**. Authorize `https://auth.fanvue.com/oauth2/auth`, token `POST https://auth.fanvue.com/oauth2/token` (form-encoded) with `Authorization: Basic base64(client_id:client_secret)` (secret in the body is rejected).
- Scopes used: `openid offline_access offline read:self read:chat write:chat read:fan read:media write:media read:insights read:creator`. They must also be ticked in the app's Authentication tab.
- Access token ~1 h. Refresh tokens **rotate and are single-use** (30 s grace); reuse after that invalidates the chain → reconnect.
- "Login session does not match the signed-in account": the browser is logged in to Fanvue as another account. `prompt=login` forces a fresh login (the callback page offers it).
- Every call: `Authorization: Bearer …`, `X-Fanvue-API-Version: 2025-06-26`, base `https://api.fanvue.com`.

## Chats and messages

- `GET /v1/chats?filter=unread&size=50`: chat = fan's user uuid; `lastMessage {uuid, text, senderUuid, senderRole: FAN|CREATOR|…}`.
- `GET /v1/chats/{fan}/messages?limit=1-50&markAsRead=false`: newest first; `sender.uuid`. v1 default for `markAsRead` is **false**.
- `GET /v1/chats/{fan}/messages/{uuid}`: full message incl. `pricing` and **`purchasedAt`** (used to detect PPV purchases).
- `POST /v1/chats/{fan}/message {text?, mediaUuids?, price?}` → `{messageUuid}`. **price in cents, min 300**; the $500 default ceiling is *not* enforced by the endpoint.
- `POST /v1/chats/{fan}/typing {isTyping: true}`: best effort.
- `PATCH /v1/chats/{fan} {isRead: true}`.
- Skip message types `AUTOMATED_*`, `BROADCAST`, `GHOST_PROMOTION`, `MARKETING_*`, `VOICE_CALL`.

## Media

- `GET /v1/media?size=50&cursor=…`: items `{uuid, status: created|processing|ready|error, mediaType}`. URLs only via `?variants=main,thumbnail`; signed and short-lived (don't store).
- Upload: `POST /v1/media/uploads {name, filename, mediaType: "image", sizeBytes}` → `{mediaUuid, uploadId, totalParts}` → `GET /v1/media/uploads/{uploadId}/parts/1/url` (**returns a plain-text URL**) → `PUT` bytes (keep `ETag`) → `PATCH /v1/media/uploads/{uploadId} {parts:[{PartNumber, ETag}]}` → poll `GET /v1/media/{uuid}` until `ready`.
- Uploaded media appears in the creator's vault.
- Abandoned uploads stay as `status: created` items.

## Webhooks

- `POST /v1/webhooks/subscriptions {url, events}` returned **400 "Bad Request"** for every variation tried with a private app (Oct 2026). The app's **Events** tab (one per-app signing secret) is the other way to register; this project polls every minute instead.
- Signature: `X-Fanvue-Signature: t=<unix>,v0=<hex>` = HMAC-SHA256(secret, `${t}.${rawBody}`), reject if older than 5 min. Payload keys are snake_case; optional keys are omitted, not null.

## Limits and errors

- 200 requests / 60 s per app+creator (token bucket), `Retry-After` on 429.
- Errors have no single envelope (`{error}`, `{message}`, `{errors: []}`).

## Policy (summary, not legal advice)

- API chatbots are officially supported (Fanvue publishes an auto-reply chatbot example).
- AI content must be disclosed; AI creator accounts carry an "AI" badge.
- API policy: apps must be created by the developer who operates them; users connect via OAuth. In this course every member creates and operates their own app for their own deployment.
