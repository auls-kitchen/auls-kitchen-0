// FREEZE GATE (run with: npm run verify:frozen). Not part of `npm test`.
//
// aul-world-runtime/, kiosk/ and functions/ (and the deploy/Firebase config)
// are frozen for this work. This gate proves the working tree is byte-identical
// to git HEAD there: no tracked change, and no untracked file. It is a
// tripwire, not a unit test - it depends on git and on the repository state,
// which is why it is a separate script and is skipped when git is unavailable.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let repoRoot: string | null = null;
try {
  repoRoot = git(["rev-parse", "--show-toplevel"], HERE);
} catch {
  repoRoot = null;
}

const FROZEN = ["aul-world-runtime", "kiosk", "functions", ".github", "firebase.json", ".firebaserc"];

test("F1. no tracked file under a frozen path differs from HEAD", { skip: repoRoot === null ? "git not available" : false }, () => {
  const changed = git(["diff", "--name-only", "HEAD", "--", ...FROZEN], repoRoot!);
  assert.equal(changed, "", `frozen files changed:\n${changed}`);
});

test("F2. no untracked file exists under a frozen path (gitignored build output excluded)", { skip: repoRoot === null ? "git not available" : false }, () => {
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...FROZEN], repoRoot!);
  assert.equal(untracked, "", `untracked files under frozen paths:\n${untracked}`);
});

test("F3. the frozen AWR entry point is untouched: main.ts matches HEAD exactly", { skip: repoRoot === null ? "git not available" : false }, () => {
  const head = git(["rev-parse", "HEAD:aul-world-runtime/src/main.ts"], repoRoot!);
  const worktree = git(["hash-object", "aul-world-runtime/src/main.ts"], repoRoot!);
  assert.equal(worktree, head);
});
