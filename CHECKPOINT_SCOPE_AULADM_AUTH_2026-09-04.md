# CHECKPOINT — SCOPE: AUL-ADM AUTHENTICATION GATE

Date: 2026-09-04

## 1. Checkpoint Identity

- Scope name: AUL-ADM Authentication Gate
- Date: 2026-09-04
- Status: IMPLEMENTATION COMPLETE / RUNTIME VERIFICATION BLOCKED
- Local commit: `0548647ee421f103b0488b570530e9485257158b`
- Remote status: NOT PUSHED

## 2. Architecture Decisions

- AUL-ADM now uses Firebase Authentication.
- Initial authentication provider: Email/Password.
- Single owner-admin identity.
- No self-service signup.
- No PIN.
- No biometric implementation in this scope.
- Future Passkey/WebAuthn + biometric remains a planned future capability.
- Authorization strategy selected: UID allowlist.
- UID allowlist is NOT implemented yet in this scope.
- POS Anonymous Auth remains unchanged.
- `posSale` remains unchanged.
- No broad application refactor.

## 3. Implementation

- File changed: `aul-adm.html`
- 179 insertions, 0 deletions.
- Firebase Auth imports added using the existing Firebase SDK version/pattern (`firebasejs/10.12.2/firebase-auth.js`, matching every other import already in the file).
- Auth state model:
  - `AUTH_CHECKING`
  - `LOGIN_REQUIRED`
  - `AUTHENTICATED`
- Existing AUL-ADM operational initialization is gated behind authenticated state via `initAdminApp()` — a function, not merely a CSS toggle, containing every pre-existing render function, event handler, and Firestore call in the file.
- Firestore listeners/writes do not initialize before authentication — confirmed by direct inspection: `function initAdminApp() {` opens the block and every one of the file's Firestore read/write call sites (`onSnapshot` ×5, `addDoc` ×4, `deleteDoc` ×3, `updateDoc` ×3, `setDoc` ×1) falls strictly inside it; none exist outside.
- Logout (`#logoutBtn` → `signOut(auth)`) returns the application to `LOGIN_REQUIRED` via the same single `onAuthStateChanged` listener.
- No credentials hardcoded or manually stored (no `localStorage`/`sessionStorage` writes were added).
- Existing AUL-ADM business/financial/HPP logic was not changed — the change is a pure zero-deletion wrap around previously-audited code.

## 4. Verification

**Static verification:**
- JS syntax check: PASS.
- Final diff audit: PASS.
- Scope compliance: PASS.
- Regression risk: LOW.
- No blocking findings.

**Runtime verification:**
- Browser-based Firebase Auth emulator verification: **BLOCKED.**
- Exact environment limitation: sandbox outbound access to `www.gstatic.com:443` is denied, preventing Firebase Web SDK CDN imports from loading in this sandbox's browser.
- This is the same previously documented environment limitation from Scope 23D-2 UI verification (23D-2-UI-2/UI-3).
- No network-policy workaround was attempted.

Source/static verification = **PASS**. Browser runtime verification = **BLOCKED BY ENVIRONMENT**. These are explicitly distinct and must not be conflated.

## 5. Tests Not Yet Closed

The following remain open runtime verification gaps, blocked by the environment limitation above, not by any known defect:

- LOGIN_REQUIRED with no user
- Invalid credentials
- Valid emulator login
- AUTHENTICATED transition
- Existing admin UI after login
- Logout
- Reload/session persistence
- Runtime Firestore functionality after authentication

## 6. Security Status

- AUL-ADM login gate is implemented.
- **This login gate is NOT yet the final Firestore security boundary.**
- Production Firestore Rules still use the temporary security bridge.
- Current bridge expires **2026-09-21 00:00 UTC**.
- Final Firestore authorization using UID allowlist is a separate future scope.
- **Do not claim production Firestore is secured by this checkpoint.**
- The future Rules migration must replace the temporary bridge before expiry.

## 7. Production Safety

- No production Auth user created.
- No production Firestore read/write/mutation performed during this scope.
- No production Rules modified.
- No deploy.
- No push.
- No changes to `aul-pos.html`.
- No changes to `functions/`.

## 8. Working Tree at Checkpoint

Expected standing state (before this checkpoint file is committed):
```
 M firebase.json
?? firestore.rules
```
These are the pre-existing EMU-4 local emulator files and are intentionally outside this checkpoint.

The newly implemented `aul-adm.html` is clean because it is already committed (`0548647ee421f103b0488b570530e9485257158b`).

## 9. Next Planned Sequence

A. Push approved local commits to `origin/main` after checkpoint review.
B. Firebase Console:
   - Enable Email/Password Authentication.
   - Create the single owner-admin account manually.
   - Record the resulting UID.
C. Stop and verify account setup.
D. Separate scope: Production Firestore Rules UID Allowlist Migration.
E. Emulator Rules verification.
F. Controlled production Rules verification.
G. Confirm AUL-ADM authenticated operations work.
H. Confirm unauthenticated access is denied.
I. Replace/remove temporary security bridge before 2026-09-21 00:00 UTC.
J. Future separate scope: Passkey/WebAuthn + biometric.

## 10. Checkpoint Closure Statements

Scope AUL-ADM Authentication Gate implementation is complete and the approved implementation commit exists locally.

Static/source verification is PASS.

Browser runtime verification remains BLOCKED by the sandbox Firebase Web SDK CDN access limitation.

Production Firestore authorization is NOT yet migrated; the temporary security bridge remains a separate pending scope.

No production data, Authentication user, Security Rules, or deployment was modified in this scope.

Next security milestone is Production Firestore Rules UID Allowlist Migration after owner Authentication setup.
