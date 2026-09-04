# CHECKPOINT — PRODUCTION FIRESTORE SECURITY RULES MIGRATION

## Scope: AUL-ADM Authentication → Firestore Rules UID Allowlist Migration

Date: 2026-09-04

## 1. Checkpoint Identity

- Scope name: Production Firestore Security Rules Migration
- Date: 2026-09-04
- Status: **PRODUCTION RULES PUBLISHED AND VERIFIED (read paths + one live owner-write), TEMPORARY BRIDGE SUPERSEDED**
- This is a **documentation-only** checkpoint. No repository file other than this checkpoint document was created or modified by this scope.

## 2. Migration History (all phases)

| Phase | Description | Result |
|---|---|---|
| Phase 1 | Read-only access matrix + Rules architecture draft | Draft produced, not yet safe to publish (own assessment at the time) |
| Phase 2 | Emulator verification of the exact Phase 1 draft, using owner UID `IXgT0vd5cqM4M8q7Sg4fxzGiOrp1` | **73/73 tests PASS, 0 FAIL, 0 discrepancies** |
| Phase 3A | Production owner UID independently verified from Firebase Console | PASS — confirmed `IXgT0vd5cqM4M8q7Sg4fxzGiOrp1` |
| Phase 3B | Current production Rules baseline inspected read-only in Firebase Console | PASS — confirmed temporary security bridge (expiry 2026-09-21 00:00 UTC), `transactions` still allowed CREATE under that bridge at the time of inspection |
| Phase 3C | Release-candidate review (architecture, static/structural verification) | PASS — release candidate confirmed consistent with Phase 1/Phase 2, not yet published at that point |
| **Publish** | Release candidate published to production Firebase Console | Reported by the project owner (outside this sandbox — this sandbox has no Firebase Console access and did not perform the publish) |
| Post-publish read verification | Repository integrity re-audit + static app-compatibility audit + genuine read-only production REST verification | **PASS** for every tested path (see Section 3) |
| **Live owner-write verification** | AUL-ADM owner-authenticated session (performed by the project owner, outside this sandbox) wrote a new `ingredients` document | **PASS — independently corroborated** (see Section 4) |

## 3. Post-Publish Read Verification (recap)

Direct, unauthenticated, read-only HTTP GET requests were issued from this
sandbox against the live production Firestore REST API
(`firestore.googleapis.com`, project `auls-kitchen`) — no credentials
used, no write attempted:

| Path | Expected | Actual | Result |
|---|---|---|---|
| products | ALLOW | 200 | MATCH |
| categories | ALLOW | 200 | MATCH |
| ingredients | ALLOW | 200 | MATCH |
| status/soldOut | ALLOW | 200 | MATCH |
| status/shopOpen | ALLOW | 200 | MATCH |
| status/liveTicket | ALLOW | 200 | MATCH |
| status/txPopup | ALLOW | 200 | MATCH |
| expenses | DENY | 403 | MATCH |
| transactions | DENY | 403 | MATCH |
| purchases | DENY | 403 | MATCH |
| orderIntents | DENY | 403 | MATCH |
| arbitrary unlisted collection | DENY | 403 | MATCH |

## 4. Live Owner-Write Verification (NEW — this checkpoint)

**Reported event:** the AUL-ADM owner-authenticated session (real Firebase
Email/Password login, performed by the project owner directly against
production — outside this sandbox, which has no ability to load the
Firebase Web SDK or hold real owner credentials) successfully created a
new `ingredients` document via the AUL-ADM "Tambah Bahan Baku" flow:
name "Sedotan Boba", stock 320 pcs, minStock 200 pcs, avgCost Rp90/pcs.

**Independent corroboration performed by this session:** a read-only,
unauthenticated HTTP GET against the live production `ingredients`
collection (the same legitimate REST-verification method already used
for Section 3, `products`-read-is-public applies equally here) was
issued to confirm the document's real, current existence and field
values, without relying solely on the reported description:

```
ingredients/Adh0zDdeSEavKRJMCVqU
{
  "name": "Sedotan Boba",
  "stock": 320,
  "minStock": 200,
  "avgCost": 90,
  "unit": "pcs",
  "createTime": "2026-09-04T18:36:30.674962Z",
  "updateTime": "2026-09-04T18:36:30.674962Z"
}
```

Every field matches the reported values exactly. `createTime` equals
`updateTime`, confirming this document was created fresh in a single
write — consistent with a genuine new-ingredient creation (`addDoc`)
rather than an edit of a pre-existing record. This corroboration was
obtained via a plain read-only GET; this session did not perform, witness
in real time, or independently trigger the write itself — the write act
and the authenticated session that produced it remain reported by the
project owner, not something this sandbox executed or observed directly.
No document was modified, created, or deleted by this checkpoint scope.

**Conclusion:** this is real, corroborated evidence that the owner UID
`IXgT0vd5cqM4M8q7Sg4fxzGiOrp1`, when actually authenticated via the
AUL-ADM login gate against production, receives write access to
`ingredients` exactly as the published Rules' `isOwner()` function is
designed to grant.

## 5. ADM-1 Status Update

**Prior status** (Frontend Financial/Master-Data Audit, and reiterated in
the Authentication Architecture Audit): *HIGH — access-control finding
pending verification of production Firestore Security Rules, since
aul-adm.html itself carries no client-side authentication or
authorization.*

**Updated status: PASS — production owner-write verified.**

Rationale: aul-adm.html's own lack of a *client-side* authorization
mechanism (still architecturally true — the Firebase Auth Email/Password
gate added in the AUL-ADM Authentication Gate scope is the actual
authorization layer, not a separate in-app check) is no longer an open
security question, because:
1. The actual production Firestore Security Rules are now published and
   enforce `isOwner()` (exact UID match) for every AUL-ADM write path.
2. Read-only production verification (Section 3) directly proved
   unauthenticated callers are denied write-relevant collections
   (`expenses`, `transactions`, `purchases`) at the read level, and by
   design (Phase 2, 73/73 PASS) at the write level for the identical
   rule text.
3. This checkpoint's live owner-write verification (Section 4) closes
   the remaining gap by corroborating, with real production evidence,
   that the legitimate owner identity — not merely "some authenticated
   user" — is the one actually granted write access.

ADM-1 is closed. The three items in Section 6 remain explicitly open and
are not resolved by this evidence.

## 6. Explicitly Remaining NOT PROVEN

The following are **not** resolved by any evidence gathered to date and
must not be represented as proven:

1. **Production non-owner authenticated behavior** — no second real
   authenticated identity (a genuine Firebase Auth user that is not the
   owner) has been tested against live production. Proven only at the
   design/emulator level (Phase 2, non-owner UID, 73/73 PASS included
   this case).
2. **Browser transaction write denial against production** — no write
   attempt of any kind (allowed or forbidden) has been made against
   production `transactions` from any actor, owner included, since this
   would require either an explicit, separately-authorized production
   write test or the owner performing and reporting one. Proven only at
   the design/emulator level (Phase 2: `transactions` write is `if
   false`, unconditional, tested and confirmed denied even for the
   owner UID in the emulator).
3. **Byte-for-byte identity of the live production Rules source text
   versus the Release Candidate** — this sandbox has no credentialed
   access to the Firebase Console or Management API to fetch the literal
   published rules text for a textual comparison. All evidence for Rules
   *behavior* is black-box (observed request outcomes), not a source
   diff.

## 7. Evidence Consistency Statement

Phase 2 emulator verification (73/73 PASS, exact Release Candidate rule
text, real owner and non-owner UIDs), the post-publish live read
verification (Section 3, 12/12 paths matching expected behavior against
real production), and this checkpoint's live authenticated-owner
`ingredients` write verification (Section 4, independently corroborated)
are **mutually consistent** — no contradiction, discrepancy, or
unexpected result has appeared at any point across all three evidence
sources. Together they establish a coherent, multi-layered (design →
emulator → live-read → live-owner-write) verification trail for the
published Rules, while Section 6's three items remain honestly
unresolved rather than assumed.

## 8. Production Safety

- No production data was created, updated, or deleted by this session at
  any point in this checkpoint scope — only one read-only GET request
  was issued, against a collection already established as public-read.
- The one production write described in Section 4 was performed by the
  project owner, not by this session, and is not to be deleted, altered,
  or used as a basis for any further production write in this or any
  adjacent scope, per explicit instruction.
- No application code was changed. No `firestore.rules` (local,
  emulator-only) or `firebase.json` file was changed. No deploy occurred.

## 9. Standing Local Files

```
 M firebase.json
?? firestore.rules
```
These remain the pre-existing, EMU-4, local-emulator-only files —
unrelated to and unaffected by the production Rules now live in Firebase
Console. They are explicitly **not** treated as the production Rules
source at any point in this migration, and are not committed by this or
any prior checkpoint in this series.
