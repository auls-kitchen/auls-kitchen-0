// Test support: a deterministic monotonic Clock and Scheduler.
//
// advanceBy(ms)  moves time forward, firing due timeouts in order as time
//                passes (an ideal, punctual scheduler).
// jumpBy(ms)     moves the clock forward WITHOUT firing anything, so the test
//                can then fireDue() late - simulating a throttled background
//                tab whose timeout fires long after its deadline.
// fireStale()    calls callbacks that were already cleared, simulating a
//                scheduler that fires a cancelled timeout anyway.

import type { Clock, Scheduler } from "../../../src/contracts.ts";

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly delay: number;
  readonly callback: () => void;
}

export interface FakeTime {
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  now(): number;
  setNow(ms: number): void;
  advanceBy(ms: number): void;
  jumpBy(ms: number): void;
  fireDue(): void;
  fireStale(): number;
  pendingCount(): number;
  maxPendingSeen(): number;
  scheduledDelays(): readonly number[];
  clearCount(): number;
}

// Deliberately non-zero and fractional: the code under test must rely on
// differences, never on absolute time.
export function createFakeTime(startAt = 1_000.5): FakeTime {
  let now = startAt;
  let nextId = 1;
  let maxPending = 0;
  let clears = 0;
  const pending = new Map<number, Pending>();
  const cleared: Array<() => void> = [];
  const delays: number[] = [];

  const scheduler: Scheduler = {
    set(callback, delayMs) {
      const id = nextId++;
      pending.set(id, { id, at: now + delayMs, delay: delayMs, callback });
      delays.push(delayMs);
      maxPending = Math.max(maxPending, pending.size);
      return id;
    },
    clear(handle) {
      const entry = pending.get(handle as number);
      clears += 1;
      if (entry) {
        cleared.push(entry.callback);
        pending.delete(entry.id);
      }
    },
  };

  function earliestDue(limit: number): Pending | null {
    let best: Pending | null = null;
    for (const entry of pending.values()) {
      if (entry.at <= limit && (best === null || entry.at < best.at || (entry.at === best.at && entry.id < best.id))) {
        best = entry;
      }
    }
    return best;
  }

  return {
    clock: { now: () => now },
    scheduler,
    now: () => now,
    setNow(ms) {
      now = ms;
    },
    advanceBy(ms) {
      const target = now + ms;
      for (let due = earliestDue(target); due !== null; due = earliestDue(target)) {
        now = Math.max(now, due.at);
        pending.delete(due.id);
        due.callback();
      }
      now = target;
    },
    jumpBy(ms) {
      now += ms;
    },
    fireDue() {
      for (let due = earliestDue(now); due !== null; due = earliestDue(now)) {
        pending.delete(due.id);
        due.callback();
      }
    },
    fireStale() {
      const callbacks = cleared.splice(0, cleared.length);
      for (const callback of callbacks) callback();
      return callbacks.length;
    },
    pendingCount: () => pending.size,
    maxPendingSeen: () => maxPending,
    scheduledDelays: () => [...delays],
    clearCount: () => clears,
  };
}
