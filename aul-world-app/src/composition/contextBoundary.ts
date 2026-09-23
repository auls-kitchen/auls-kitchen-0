// Context boundary (U4 Slice 2B, S4a) - pure, injected, unwired.
//
// It answers exactly one question: when a piece of work that was started for one
// customer context finishes, is that context STILL the current one? If a newer
// context has begun in the meantime, the finished work must not change anything the
// newer context can see. It is an orchestration guard, not a state of the business:
// it knows no Domain, no World, no shell, no clock, and nothing about what the work
// was or what its outcome means (the outcome type is the caller's).
//
//   epoch (gen)   the primary and ONLY authority. It advances each time a new customer
//                 context begins (the caller decides when). A token captures the epoch
//                 it was issued in; it is "current" only while no newer epoch has begun.
//                 A stale token can never be made current again.
//   touch         SECONDARY, input-order protection only. It counts customer-caused
//                 interaction the caller reports. It can veto a specific optional effect
//                 (worldQuiet), but it never authorizes anything and never revokes an
//                 epoch's authority: isCurrent ignores it entirely.
//   owner         a single slot for the ONE piece of work in flight. Only the work's
//                 starter may register; while the slot is taken nobody else can, so a
//                 later context can never receive an earlier context's outcome. The
//                 outcome of the work goes to its owner alone, and only while the owner's
//                 token is still current.
//   dispose       drops the owner and makes every token stale for good: nothing is
//                 authorized afterwards, and a late outcome is discarded.
//
// Fail closed everywhere: tokens are opaque. Only a token this boundary itself issued is
// ever recognised, so a hand-made, malformed or foreign token is never current, never
// quiet, and can never own anything.

export interface BoundaryToken {
  readonly gen: number;
  readonly touch: number;
}

export interface ContextBoundary<Outcome> {
  // A new context begins: the epoch advances, and a token for it is returned.
  beginEpoch(): BoundaryToken;
  // The authority check: true only for a token issued in the CURRENT epoch, before dispose.
  isCurrent(token: BoundaryToken): boolean;
  // Records one customer-caused interaction (secondary; see above).
  noteWorldTouch(): void;
  // True only if no interaction has been recorded since the token was issued.
  worldQuiet(token: BoundaryToken): boolean;
  // Registers the single piece of work in flight. Returns false, registering nothing, if
  // the token is not current, if work is already in flight, or after dispose.
  own(token: BoundaryToken, run: (outcome: Outcome) => void): boolean;
  // The in-flight work finished. The slot is emptied FIRST, then - only if the owner's
  // token is still current - the owner receives the outcome, exactly once.
  settle(outcome: Outcome): void;
  dispose(): void;
}

export function createContextBoundary<Outcome = unknown>(): ContextBoundary<Outcome> {
  let disposed = false;
  let gen = 0;
  let touch = 0;
  let owner: { readonly token: BoundaryToken; readonly run: (outcome: Outcome) => void } | null = null;
  // Every token this boundary has issued, and nothing else. Frozen, so its numbers are safe to read.
  const issued = new WeakSet<object>();

  // The token itself if this boundary issued it; null for anything else (never throws).
  function recognised(token: unknown): BoundaryToken | null {
    return typeof token === "object" && token !== null && issued.has(token) ? (token as BoundaryToken) : null;
  }

  function isCurrent(token: BoundaryToken): boolean {
    if (disposed) return false;
    const known = recognised(token);
    return known !== null && known.gen === gen;
  }

  return Object.freeze({
    beginEpoch(): BoundaryToken {
      gen += 1;
      const token: BoundaryToken = Object.freeze({ gen, touch });
      issued.add(token);
      return token;
    },

    isCurrent,

    noteWorldTouch(): void {
      touch += 1;
    },

    worldQuiet(token: BoundaryToken): boolean {
      if (disposed) return false;
      const known = recognised(token);
      return known !== null && known.touch === touch;
    },

    own(token: BoundaryToken, run: (outcome: Outcome) => void): boolean {
      if (typeof run !== "function") throw new TypeError("own requires a run function");
      if (disposed || owner !== null || !isCurrent(token)) return false;
      owner = Object.freeze({ token, run });
      return true;
    },

    settle(outcome: Outcome): void {
      // Emptied before anything runs, so a throwing or re-entrant owner cannot wedge the slot.
      const settled = owner;
      owner = null;
      if (disposed || settled === null) return;
      if (!isCurrent(settled.token)) return; // stale: the newer context is never touched
      settled.run(outcome);
    },

    dispose(): void {
      disposed = true;
      owner = null;
    },
  });
}
