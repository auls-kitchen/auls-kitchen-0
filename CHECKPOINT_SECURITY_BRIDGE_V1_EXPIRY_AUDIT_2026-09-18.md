# CHECKPOINT — SECURITY BRIDGE v1 EXPIRY AUDIT

## Scope: Fresh Re-Verification of Production Firestore Security Bridge Status

Date: 2026-09-18

## 1. Checkpoint Identity

- Scope name: Security Bridge v1 Expiry Audit
- Date: 2026-09-18
- Status: **SECURITY BRIDGE v1 = SUPERSEDED / NO EXTENSION REQUIRED**
- This is a **documentation-only** checkpoint. No repository file other than this checkpoint document was created or modified by this scope.
- Branch: `step87-auth-browser`
- HEAD at time of audit: `8b4e4b6d38c477dcab603fe26c33c7777b4166c2` ("CHECKPOINT: STEP 87-88 real browser verification closed")
- Working tree at time of audit: clean, no uncommitted changes.

## 2. Historical Context (from prior checkpoints, not re-witnessed by this session)

Recovered from `CHECKPOINT_SCOPE_AULADM_AUTH_2026-09-04.md` and
`CHECKPOINT_SCOPE_FIRESTORE_RULES_MIGRATION_2026-09-04.md`:

- A temporary Firestore Security Rules bridge existed in production, documented
  expiry: **2026-09-21 00:00 UTC / 07:00 WIB**.
- The Firestore Rules Migration checkpoint (2026-09-04) already reported this
  bridge as **superseded** by a published UID-allowlist rule set on that same
  date, corroborated at the time by:
  - 12/12 read-only production REST checks matching expected ALLOW/DENY
    behavior (this session's predecessor checkpoint, Section 3).
  - One live owner-authenticated write to `ingredients`, reported by the
    project owner and independently corroborated via a read-only GET
    (Section 4 of that checkpoint).
- That checkpoint explicitly stated the sandbox at that time had **no
  credentialed access to Firebase Console or the Management API** to fetch
  the literal published Rules source text — Rules behavior was established
  black-box (observed request outcomes), not via a source diff.

This checkpoint does not claim the 2026-09-04 bridge-supersession event
itself was independently witnessed by any Claude Code session — that event
is, and remains, project-owner-reported/Console-side, consistent with how
the original 2026-09-04 checkpoint recorded it.

## 3. Current LIVE Production Rules — Reported by Project Owner (2026-09-18)

**Provenance:** the following facts about the current live Firestore
Security Rules were observed directly in the Firebase Console by the
project owner and reported to this session on 2026-09-18. This Claude Code
session has no Firebase Console or Management API access and did not
observe the Rules source text, the Console UI, or the deployment history
list itself. These items are recorded as **owner-reported**, not as
sandbox-verified.

- Production Rules deployment history shows the current Rules deployment
  timestamped **2026-09-05 01:10 AM**, as observed in Console.
- `isOwner()` is implemented as `request.auth != null` combined with a
  match against the designated owner Firebase Auth UID.
- `products` / `categories` / `ingredients` writes require `isOwner()`.
- `expenses` / `purchases` read and write require `isOwner()`.
- `transactions` read requires `isOwner()`; direct write is `false`
  (unconditionally denied, matching the emulator-verified design from the
  2026-09-04 migration checkpoint's Phase 2).
- `status/*` remains public read/write. This is **explicitly recorded as a
  separate, future security follow-up** — it is **not** changed, assessed,
  or resolved by this audit scope.
- `orderIntents` direct read/write is `false`.
- Catch-all (any unlisted path) read/write is `false`.
- The current LIVE Rules, as observed by the project owner, contain **no
  visible expiry clause referencing 2026-09-21**.

## 4. Fresh Direct Evidence — Verified by This Session (2026-09-18)

Unlike Section 3, the following was directly executed and observed by this
Claude Code session, via genuine unauthenticated HTTPS GET requests against
the live production Firestore REST API
(`firestore.googleapis.com`, project `auls-kitchen`). No credentials were
used. No write of any kind was attempted.

| Path | Expected (per Sec. 3 rules + 2026-09-04 precedent) | Actual (2026-09-18) | Result |
|---|---|---|---|
| products | ALLOW | 200 | MATCH |
| categories | ALLOW | 200 | MATCH |
| ingredients | ALLOW | 200 | MATCH |
| status/soldOut | ALLOW | 200 | MATCH |
| status/shopOpen | ALLOW | 200 | MATCH |
| status/liveTicket | ALLOW | 200 | MATCH |
| status/txPopup | ALLOW | 200 | MATCH |
| expenses | DENY (unauthenticated) | 403 | MATCH |
| transactions | DENY (unauthenticated) | 403 | MATCH |
| purchases | DENY (unauthenticated) | 403 | MATCH |
| orderIntents | DENY (unauthenticated) | 403 | MATCH |
| arbitrary unlisted collection | DENY (unauthenticated) | 403 | MATCH |

**Result: 12/12 paths matched the previously established expected
behavior.**

This confirms, as of 2026-09-18, that unauthenticated production behavior
is unchanged from the 2026-09-04 baseline. This black-box result alone
cannot distinguish rules-source content (that is Section 3's owner-reported
territory) — it corroborates *behavior*, not *text*.

## 5. Evidence Boundary Statement

- Section 3 (Rules content, deployment timestamp, absence of expiry
  clause) = **owner-reported, Console-observed, outside this sandbox**.
- Section 4 (12/12 REST behavior match) = **directly executed and observed
  by this session**.
- These two evidence sources are treated as separate and are not
  conflated. Together — owner-reported Rules content showing no expiry
  clause, plus this session's fresh black-box behavioral confirmation —
  they support the decision in Section 6, but the Rules *source text*
  itself was never independently fetched or diffed by any Claude Code
  session (same limitation as 2026-09-04).

## 6. Decision

**SECURITY BRIDGE v1 = SUPERSEDED / NO EXTENSION REQUIRED.**

Basis:
1. The temporary bridge's documented expiry (2026-09-21 00:00 UTC) has not
   yet passed as of this audit (2026-09-18), but the bridge was already
   reported superseded by permanent Rules on 2026-09-04.
2. The project owner reports the current LIVE Rules (deployed 2026-09-05,
   per Console history) contain no visible clause tied to the 2026-09-21
   date.
3. Fresh, this-session-executed, unauthenticated black-box verification on
   2026-09-18 shows production read/write-denial behavior unchanged and
   consistent with the permanent UID-allowlist design (12/12 match).

No extension of the temporary bridge is required because the current live
Rules are reported to be the permanent replacement, not the temporary
bridge, and fresh behavioral evidence is consistent with that report.

## 7. Explicitly Remaining NOT PROVEN / Follow-ups

1. `status/*` public read/write — explicitly out of scope for this audit;
   flagged as a separate future security follow-up, not evaluated or
   changed here.
2. No Claude Code session has independently fetched or diffed the literal
   Rules source text via a credentialed Console/Management API path; all
   Rules-content evidence in Section 3 remains owner-reported.
3. Non-owner authenticated behavior and browser-level transaction-write
   denial against production remain unverified by live testing (same open
   items carried forward from the 2026-09-04 checkpoint, Section 6).
4. No fresh owner-authenticated write test was performed in this audit
   (out of scope; no production credentials used or available to this
   session).

## 8. Production Safety

- No production write was attempted at any point in this audit.
- No production data was created, updated, or deleted.
- No `firestore.rules` (local) or `firebase.json` file was changed.
- No deploy occurred.
- No push occurred.
- No merge occurred.
- No application code was changed.
- STEP 89 was not started.
- Production Firebase configuration and Rules were not changed by this
  session.

## 9. Remote Control Recovery Finding (separate note, same day)

Recorded separately as it is unrelated to the Firestore Rules audit above:

- A power loss made the previous local Claude Code session unreachable.
- After workstation recovery, a new local Claude Code session was started.
- Remote Control was re-enabled and `/rc active` was confirmed on the new
  session.
- Recovery required local session re-establishment after the power loss;
  the prior remote session did not resume into the new local process.

## 10. Working Tree at Checkpoint

Expected standing state (before this checkpoint file is committed):
```
(clean)
```
This checkpoint document is the only file added by this scope.
