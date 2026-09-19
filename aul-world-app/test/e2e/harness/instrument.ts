// Test-only instrumentation. It MUST be the first import of the harness so it
// runs before any application module evaluates.
//
//   - counts ACTIVE event listeners per target (a listener is inactive once its
//     AbortSignal aborts or removeEventListener removes it)
//   - counts OUTSTANDING animation-frame requests (requested, not yet fired or
//     cancelled)
//
// It observes; it never changes what the page does.

interface Registration {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: unknown;
  readonly capture: boolean;
  readonly signal: AbortSignal | undefined;
  removed: boolean;
}

const registrations: Registration[] = [];

const originalAdd = EventTarget.prototype.addEventListener;
const originalRemove = EventTarget.prototype.removeEventListener;

function captureOf(options: unknown): boolean {
  return typeof options === "boolean" ? options : typeof options === "object" && options !== null && (options as AddEventListenerOptions).capture === true;
}

EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
  const signal = typeof options === "object" && options !== null ? (options.signal ?? undefined) : undefined;
  registrations.push({ target: this, type, listener, capture: captureOf(options), signal, removed: false });
  return originalAdd.call(this, type, listener, options);
};

EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
  const capture = captureOf(options);
  for (const registration of registrations) {
    if (!registration.removed && registration.target === this && registration.type === type && registration.listener === listener && registration.capture === capture) {
      registration.removed = true;
    }
  }
  return originalRemove.call(this, type, listener, options);
};

const outstandingFrames = new Set<number>();
const originalRaf = window.requestAnimationFrame.bind(window);
const originalCaf = window.cancelAnimationFrame.bind(window);

window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  const id: number = originalRaf((time) => {
    outstandingFrames.delete(id);
    callback(time);
  });
  outstandingFrames.add(id);
  return id;
};
window.cancelAnimationFrame = (id: number): void => {
  outstandingFrames.delete(id);
  originalCaf(id);
};

function isActive(registration: Registration): boolean {
  return !registration.removed && !(registration.signal?.aborted === true);
}

export const instrument = {
  activeListenersOn(target: EventTarget): Array<{ type: string; capture: boolean }> {
    return registrations.filter((r) => r.target === target && isActive(r)).map((r) => ({ type: r.type, capture: r.capture }));
  },
  totalRegistrationsOn(target: EventTarget): number {
    return registrations.filter((r) => r.target === target).length;
  },
  outstandingFrames(): number {
    return outstandingFrames.size;
  },
};
