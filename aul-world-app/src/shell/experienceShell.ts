// Experience shell DOM (U3) - the browser-side Experience surface that lives
// INSIDE the continuous AUL World page, beside the AWR canvas, not in a
// separate application.
//
// It renders a state (see shellModel.ts) as data-* attributes plus one short
// status line, and offers two interactive controls: a Menu button that asks the
// World to open its menu, and a Home (X) button - the customer's "I am done /
// this is mine now" intent. Both are the shell's own customer-facing targets
// (the canvas menu portal is another), so a touch that wakes the kiosk can also
// activate a real target.
//
// It holds no Domain handle and has no Domain action of any kind. Its outputs
// are callbacks supplied by the Composition root: onMenu, and onHome, which
// receives only the phase the Experience was in before the customer's press. A
// Home click that is not a trusted customer activation with a latched press
// (see resolveHomeActivation) is dropped here and never reaches the callback.
// Listeners are bound to one AbortController signal and removed by dispose().

import { initialShellState, resolveHomeActivation, shellAttributes, withHabitat, withWake } from "./shellModel.ts";
import type { ConsumeGesture, HomeRequest, ShellState, WorldMirror } from "./shellModel.ts";
import type { InteractionPhase } from "../experience/interactionContext.ts";
import type { WakeDecision } from "../experience/pendingTicket.ts";

export interface ExperienceShellOptions {
  // Called when the customer activates the Menu button.
  readonly onMenu: () => void;
  // Called when a trusted customer activates Home/X, with the phase before the press.
  readonly onHome: (request: HomeRequest) => void;
  // Hands out the latched press exactly once (the lifecycle's consumeGesture).
  readonly consumeGesture: ConsumeGesture;
  readonly domainStatus: string;
}

export interface ExperienceShell {
  readonly element: HTMLElement;
  setPhase(phase: InteractionPhase): void;
  setWake(decision: WakeDecision): void;
  setDomainStatus(status: string): void;
  setDomainEvent(eventType: string): void;
  setWorld(world: WorldMirror): void;
  getState(): ShellState;
  dispose(): void;
}

export function createExperienceShell(parent: HTMLElement, options: ExperienceShellOptions): ExperienceShell {
  const doc = parent.ownerDocument;
  const controller = new AbortController();

  const element = doc.createElement("aside");
  element.setAttribute("data-experience-shell", "");
  element.style.cssText = "flex:1;min-width:260px;";

  const menuButton = doc.createElement("button");
  menuButton.type = "button";
  menuButton.setAttribute("data-shell-action", "menu");
  menuButton.textContent = "Menu";
  menuButton.addEventListener("click", () => options.onMenu(), { signal: controller.signal });

  const homeButton = doc.createElement("button");
  homeButton.type = "button";
  homeButton.setAttribute("data-shell-action", "home");
  homeButton.setAttribute("aria-label", "Home");
  homeButton.textContent = "X";
  homeButton.addEventListener(
    "click",
    (event) => {
      const request = resolveHomeActivation(event, options.consumeGesture);
      if (request !== null) options.onHome(request);
    },
    { signal: controller.signal },
  );

  const status = doc.createElement("p");
  status.setAttribute("data-shell-status", "");

  element.append(menuButton, homeButton, status);
  parent.appendChild(element);

  let state: ShellState = initialShellState(options.domainStatus);
  const written = new Map<string, string>();

  function render(): void {
    const attributes = shellAttributes(state);
    for (const [name, value] of Object.entries(attributes)) {
      // Only touch the DOM when a value actually changed (the World ticks every frame).
      if (written.get(name) !== value) {
        element.setAttribute(name, value);
        written.set(name, value);
      }
    }
    const line = `${state.phase} / ${state.view}`;
    if (status.textContent !== line) status.textContent = line;
  }

  render();

  return Object.freeze({
    element,
    setPhase(phase: InteractionPhase): void {
      state = Object.freeze({ ...state, phase });
      if (phase === "HABITAT_IDLE") state = withHabitat(state);
      render();
    },
    setWake(decision: WakeDecision): void {
      state = withWake(state, decision);
      render();
    },
    setDomainStatus(domainStatus: string): void {
      state = Object.freeze({ ...state, domainStatus });
      render();
    },
    setDomainEvent(eventType: string): void {
      state = Object.freeze({ ...state, domainLastEvent: eventType });
      render();
    },
    setWorld(world: WorldMirror): void {
      state = Object.freeze({ ...state, world });
      render();
    },
    getState: (): ShellState => state,
    dispose(): void {
      controller.abort();
      element.remove();
    },
  });
}
