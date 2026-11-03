# Bots webhook admission (fail-closed) and outbound dead letters

Phase 0 / Phase 1 security and durability work for the bots domain, from
[super-agent harness design](architecture/super-agent-harness-design.md) §5 / Phase 0
(webhook secret fail-closed) and M7③ (outbound dead letter + retry authority).

## 1. Webhook admission is fail-closed once a secret is configured

Product rule:

- A bot with `webhookSecretRef` configured MUST reject an inbound callback whose
  loaded secret is empty or mismatched. Empty means the credential store returns
  no value for the ref (deleted, never saved, unloadable).
- A bot with no `webhookSecretRef` keeps its current admission behavior; this
  change does not force webhook bots without a configured secret to authenticate.
- The rejection shape mirrors the Feishu path in the same function: HTTP 401 with
  body `{ error: <locale webhookSecretInvalid> }`, no replies, `ok: false`.

State owner and interfaces:

- Owner: `processProviderCallback` in
  `packages/services/src/bots/botsService.ts`.
- The whole-callback gate for webhook runs next to the existing Feishu gate,
  before `prepareCallbackPayload`, keyed by `findCallbackBot`. The per-message
  guard inside the parse loop stays as defense in depth and uses the same
  fail-closed condition (`!expected || expected !== inbound`).

Root cause of the bug being fixed:

- The old loop check was `if (expectedSecret && expectedSecret !== inboundSecret)`.
  When the bot had a `webhookSecretRef` but `credentialService.load` returned an
  empty value, the whole comparison short-circuited and the message was admitted
  (fail-open). The Feishu path already used `if (!expectedToken || expectedToken !== inboundToken)`
  (fail-closed). Fix basis: unify both paths on the Feishu semantics.

Acceptance cases:

1. Ref set, loaded value empty, any inbound secret (or none) → 401, body error is
   the localized `webhookSecretInvalid`.
2. Ref set, inbound secret mismatches → 401, same body.
3. Ref set, inbound secret matches → admitted as before.
4. No ref configured → admission unchanged (message processed without secret check).
5. Feishu paths (both the early gate and the parse-loop guard) are untouched.

## 2. Outbound dead letters and bounded retry authority (M7③)

Product rules:

- Terminal bot outbound failures in the automation delivery flow no longer exist
  only as a throttled warn. Each terminal failure also writes one dead-letter row
  into bots-domain storage. The existing throttled warn
  (`warnAutomationDeliveryOnce` / stream-event warn) stays as the operational
  signal; the dead-letter row is the durable audit and retry unit.
- Covered terminal failures:
  - `watchAutomationRun` pre-check skips: `bot_missing`, `bot_disabled`,
    `provider_mismatch`, `group_not_authorized` (rows reference the automation
    run; no message text exists yet).
  - Automation-tagged terminal sends that throw in `sendTaskOutbound`
    (`reason: send_failed`; rows carry the truncated outbound text so they can be
    replayed).
- Non-automation IM replies keep their current behavior (including the in-memory
  `failedPrivateDeliveries` retry); they are not dead-lettered.

State owner and storage:

- Owner: bots domain (`packages/services/src/bots/`). New store
  `BotsOutboxDeadLetterRepo` persists `bot-outbox-dead-letter.v1.json` in the app
  config dir, following the `BotsRepo` conventions: versioned file
  (`{ version: 1, entries: [] }`), zod schema parse on read, atomic private write
  under `withFileLock`. A missing file defaults to the empty version-1 shape; a
  file that fails JSON or schema parsing (legacy-invalid/corrupted) is rewritten
  as the empty version-1 file on read, so `listOutboxDeadLetters()` /
  `retryBotOutboxDeadLetters()` never wedge on a corrupt file. A future-version
  file (`version > 1`) throws and is not silently reinterpreted; the caller sees
  the error instead of a wiped store.
- Row shape: stable `id`, `botId`, `provider`, chat target
  (`chatType`/`providerUserId`/optional thread ids), `reason`, optional
  `groupAuthorizationId` (group `send_failed` authorization snapshot), optional
  `automation` watch params (reference rows), optional truncated `payloadText`
  (+`payloadTruncated`), `attempts`, `status` (`pending` | `dropped`), `lastError`,
  `createdAt`/`updatedAt`/`nextRetryAt`.

Dead-letter lifecycle:

- First failure for a stable id writes one row with `attempts: 1`,
  `status: pending`. Re-observing the same failure upserts the same row
  (attempts + 1, refreshed `lastError`/`updatedAt`); it never appends a second row.
- Attempts are capped at 5. Reaching the cap flips `status` to `dropped`; dropped
  rows are kept for audit and are never retried or resent.
- Retry backoff: 1 minute × 2^(attempts−1), capped at 1 hour.

Retry authority:

- Explicit entry point on `IBotsService`:
  `retryBotOutboxDeadLetters({ botId? })` (no UI in this phase). Retries are
  single-flight per service instance, and only consider `pending` rows whose
  `nextRetryAt` has passed. An optional `botId` scopes the pass.
- `send_failed` rows: re-resolve the bot (must exist, be enabled, and match the
  row provider), re-send the truncated payload through the same `sendOutbound`
  path. For **group** targets the replay must re-run the same group
  authorization gate as the original automation send (group enabled, owner is
  the bot's `providerUserId`, and `groupAuthorizationId` still matches the
  snapshot stored on the row): authorization revoked or re-issued after the
  original failure means the replay is refused and accounted as `failed`
  (backoff toward `dropped`), never delivered. The replay also passes the same
  `authorize` re-check inside `sendOutbound`. Success removes the row; failure
  runs the attempt/cap accounting above.
  Note: automation group terminal sends do not go through the
  `BotGroupDelivery` idempotency ledger (they carry no `groupTaskId`/
  `deliveryId`; that ledger belongs to interactive group results). Payload
  replay therefore has the same delivery semantics as the original send —
  idempotent at the dead-letter layer (single-flight, due-scan, remove on
  success), but an ambiguous original send (delivered, ack lost) can still
  double-post on replay. Closing that gap requires routing automation group
  terminal sends through the `BotGroupDelivery` ledger (ownership of the group
  `activeTaskId`), tracked as a follow-up beyond this phase.
- `automation` reference rows: re-invoke the automation watch with the stored
  params. The watch entry resolves a typed outcome
  (`subscribed` | `precheck_failed`): pre-check failures are a normal branch
  that re-upserts the row under the same stable id (same attempts accounting),
  while a successful subscription removes the row. Retry accounting branches on
  that outcome — never on exceptions or `updatedAt` timestamps, which race with
  concurrent live-watch upserts. (The typed outcome is consumed internally by
  the retry authority; the public `IBotsService.watchAutomationRun` signature
  stays `Promise<void>` until the desktop cron consumer's local interface is
  updated together.) Restoring a reference row does not reconstruct
  a terminal result that already fired before the retry — the missed result
  stays an audited loss; the dead letter exists to make that loss visible and
  bounded, not to replay agent output that was never captured.
- No double send: only `pending` and due rows are retried; a successful retry
  removes the row in the same pass; `dropped` rows are skipped forever; concurrent
  retry calls share one in-flight pass; rows whose send already succeeded were
  never written.

Reply-policy interplay (Phase 3 forward reference):

- The payload replay path re-sends stored `payloadText` (hard-truncated at
  2000 chars). It is in scope for the future Phase 3 reply policy (≤100-word
  IM rule): when that policy lands, `retryBotOutboxDeadLetters` must apply it,
  and a truncated payload must be re-formatted through the policy before send —
  replay must never become a policy bypass. Today no such rule exists in bots
  outbound, so no current rule is violated.

Audit visibility (no UI this phase):

- `listOutboxDeadLetters()` on `IBotsService` returns the current rows read-only.

Acceptance cases:

1. A failing automation delivery writes exactly one dead-letter row for that
   stable id; a second identical failure updates the same row.
2. `retryBotOutboxDeadLetters` with a deliverable bot clears the row (send path
   used exactly once more; no duplicate delivery on success).
3. Five failed attempts flip the row to `dropped`; later retry passes skip it.
4. A `bot_missing` pre-check skip writes a reference row; retry while the bot is
   still missing keeps it pending until the cap drops it; retry after the bot is
   restored clears it.
5. `webhook` bots never appear in automation rows (delivery targets stay
   feishu/lark/weixin per the automation target schema).
6. A group `send_failed` row stores the `groupAuthorizationId` snapshot at
   failure time. Retry after the group authorization changed (revoked or
   re-issued) delivers nothing and accounts the attempt as `failed`; retry
   while the snapshot still matches delivers once and clears the row.
7. A corrupted on-disk dead-letter file is rewritten as empty version-1 on
   read and stays writable; a `version > 1` file makes reads throw instead of
   being reinterpreted or wiped.
