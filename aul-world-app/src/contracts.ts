// Type-only contracts for the Composition / Experience bridge (U0).
//
// This module contains NO runtime code - every export is a type, erased at
// compile time. It defines the narrow ports the Experience lifecycle is
// allowed to see. A port is deliberately the ONLY thing a lifecycle
// module receives: there is no Domain handle, no AWR bus, and no host
// anywhere in these shapes, so a module typed against them structurally
// cannot reach clearCart/endSession/retryUnknown/hydrate/auth reset.
//
// ExperienceSnapshotView is a structural, read-only SUBSET of the
// ExperienceSnapshot that kiosk/experience/experienceProjection.js already
// produces ({ready, session, cart, order, degraded, capabilities}). Only
// the fields the Experience needs are declared. The real snapshot is
// assignable to it; the U1 tests pin that against the real projection.

// Same lowercase vocabulary as kiosk/experience/experienceTypes.js SessionPhase.
export type SessionPhaseView = "idle" | "active" | "awaiting_outcome" | "confirmation";

// Same vocabulary as kiosk/experience/experienceTypes.js OrderStatus.
export type OrderStatusView = "NONE" | "PENDING" | "UNCERTAIN" | "CONFIRMED" | "DECLINED";

export interface ExperienceSnapshotView {
  readonly ready: boolean;
  readonly session: SessionPhaseView;
  readonly cart: { readonly lines: readonly unknown[] };
  readonly order: { readonly status: OrderStatusView };
  readonly degraded: { readonly category: string } | null;
}

// Read-only Domain access. The only Domain method the Experience lifecycle
// may hold; it is intentionally not the orchestrator.
export interface SnapshotReadPort {
  getSnapshot(): ExperienceSnapshotView;
}

// The single presentation output the lifecycle may drive. It can do exactly
// one thing, so it cannot emit any other AWR event (OBJECT_INTERACTED,
// MENU_INTENT, ...).
export interface PresentationOutPort {
  returnToWorld(): void;
}

// What kind of physical customer input this was. Only a `press` starts a new
// gesture (a tap/click, or Enter/Space on an interactive element); `drag` (a
// pressed pointer or touch moving) and `wheel` continue or accompany one.
export type CustomerInputKind = "press" | "drag" | "wheel";

// The single input the lifecycle exposes to the customer-input adapter.
// Nothing else (bus observers, Domain subscribers) is ever given this.
export interface InputSink {
  noteCustomerInput(kind?: CustomerInputKind): void;
}

// Monotonic elapsed-time source, in milliseconds. Never a wall clock.
export interface Clock {
  now(): number;
}

export interface Scheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
