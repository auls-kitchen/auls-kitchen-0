// Test support: a fake EventTarget that honors the AbortSignal contract
// (a listener registered with a signal is removed when it aborts) and lets a
// test dispatch plain-object events - including ones with isTrusted: true,
// which cannot be forged on a real Event in every runtime.
//
// It also counts registrations, so lifecycle tests can prove "no duplicate
// listener" and "no leaked listener" across repeated mount/dispose cycles.

interface Registration {
  readonly type: string;
  readonly listener: (event: unknown) => void;
  readonly options: { capture?: boolean; passive?: boolean; signal?: AbortSignal };
  active: boolean;
}

export interface EventSpy {
  readonly type: string;
  readonly isTrusted: boolean;
  readonly buttons?: number;
  readonly key?: string;
  readonly repeat?: boolean;
  readonly target?: unknown;
  readonly consumed: string[];
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export interface FakeInputTarget {
  readonly target: EventTarget;
  dispatch(event: { readonly type: string }): number;
  activeListenerCount(): number;
  totalRegistrations(): number;
  registrations(): ReadonlyArray<{ type: string; capture: boolean; passive: boolean; hasSignal: boolean; active: boolean }>;
}

export function createFakeInputTarget(): FakeInputTarget {
  const registrations: Registration[] = [];

  const fake = {
    addEventListener(
      type: string,
      listener: (event: unknown) => void,
      options: { capture?: boolean; passive?: boolean; signal?: AbortSignal } = {},
    ): void {
      const registration: Registration = { type, listener, options, active: !options.signal?.aborted };
      registrations.push(registration);
      options.signal?.addEventListener("abort", () => {
        registration.active = false;
      });
    },
    removeEventListener(): void {},
  };

  return {
    target: fake as unknown as EventTarget,
    dispatch(event) {
      let invoked = 0;
      for (const registration of registrations) {
        if (registration.active && registration.type === event.type) {
          registration.listener(event);
          invoked += 1;
        }
      }
      return invoked;
    },
    activeListenerCount: () => registrations.filter((r) => r.active).length,
    totalRegistrations: () => registrations.length,
    registrations: () =>
      registrations.map((r) => ({
        type: r.type,
        capture: r.options.capture === true,
        passive: r.options.passive === true,
        hasSignal: r.options.signal !== undefined,
        active: r.active,
      })),
  };
}

// A customer-like (trusted) event by default; pass overrides for anything else.
export function makeEvent(type: string, extra: Partial<Omit<EventSpy, "type" | "consumed">> = {}): EventSpy {
  const consumed: string[] = [];
  return {
    type,
    isTrusted: true,
    ...extra,
    consumed,
    preventDefault: () => void consumed.push("preventDefault"),
    stopPropagation: () => void consumed.push("stopPropagation"),
    stopImmediatePropagation: () => void consumed.push("stopImmediatePropagation"),
  };
}

export const trusted = {
  tap: () => makeEvent("pointerdown"),
  drag: () => makeEvent("pointermove", { buttons: 1 }),
  hover: () => makeEvent("pointermove", { buttons: 0 }),
  touchSwipe: () => makeEvent("touchmove"),
  wheel: () => makeEvent("wheel"),
  enterOnButton: () => makeEvent("keydown", { key: "Enter", repeat: false, target: { tagName: "BUTTON" } }),
};

export const synthetic = {
  tap: () => makeEvent("pointerdown", { isTrusted: false }),
  wheel: () => makeEvent("wheel", { isTrusted: false }),
  enterOnButton: () => makeEvent("keydown", { isTrusted: false, key: "Enter", repeat: false, target: { tagName: "BUTTON" } }),
};
