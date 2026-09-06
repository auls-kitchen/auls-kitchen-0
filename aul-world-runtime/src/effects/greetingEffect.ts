// The EFFECT layer for AWR-02's external-effects proof:
//
//   EVENT -> EFFECT -> EXTERNAL SYSTEM -> RESULT EVENT -> REDUCER -> STATE
//
// This module owns the asynchronous lifecycle and talks to the mock
// external service. It does NOT import the reducer, does NOT import
// PixiJS, does NOT touch the DOM, and does NOT mutate domain state
// directly — its only contract with the rest of the runtime is emitting
// a semantic result event back onto the event bus. main.ts is the only
// caller, invoked when it observes an AUL_GREETING_REQUESTED event (see
// main.ts's bus.subscribe) — this file has no bus.subscribe of its own,
// so it stays a plain function, not a hidden second event-routing system.
import type { EventBus } from "../events/bus";
import { mockGreetingService } from "../services/mockGreetingService";

export interface GreetingEffectRequest {
  forceFailure: boolean;
  requestId: number;
}

export function requestGreeting(bus: EventBus, request: GreetingEffectRequest): void {
  mockGreetingService({ forceFailure: request.forceFailure })
    .then((result) => {
      bus.emit({ type: "AUL_GREETING_READY", requestId: request.requestId, message: result.message });
    })
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : "Unknown mock service error";
      bus.emit({ type: "AUL_GREETING_FAILED", requestId: request.requestId, reason });
    });
}
