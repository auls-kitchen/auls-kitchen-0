import type { AppEvent } from "./types";

// Deliberately tiny: a single dispatch function with one list of
// subscribers. This is NOT a generic pub/sub framework — there is
// exactly one channel (AppEvent) and one intended subscriber (the
// store's dispatch loop in main.ts). Kept as its own module only to
// preserve the EVENT -> DISPATCH boundary from the architecture, not
// to grow into a general-purpose bus.

type Listener = (event: AppEvent) => void;

export function createEventBus() {
  const listeners: Listener[] = [];
  return {
    subscribe(listener: Listener): () => void {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    emit(event: AppEvent): void {
      for (const listener of listeners) listener(event);
    },
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
