import type { WorldState } from "../state/types";
import type { EventBus } from "../events/bus";
import { intentFor } from "./interactionContract";

// CUSTOMER INPUT -> HIT TEST -> OBJECT ID -> INTERACTION CONTRACT ->
// INTENT -> EVENT. The "HIT TEST" step itself (screen coords -> object
// id) is delegated to the renderer adapter, since geometric hit-testing
// against visual shapes is legitimately a rendering-foundation concern.
// Everything from OBJECT ID onward is pure domain logic with no
// renderer dependency, callable identically whether the object id came
// from canvas pointer input or a DOM test-panel button.
export function handleObjectHit(state: WorldState, objectId: string, source: "canvas" | "dom", bus: EventBus): void {
  const obj = state.objects.find((o) => o.id === objectId);
  if (!obj) return;
  const intent = intentFor(obj.class);
  if (intent === "NONE") return;
  // AWR-03: a Portal's OPEN_PORTAL intent crosses into the World ->
  // Ordering boundary as MENU_INTENT instead of the generic
  // OBJECT_INTERACTED event used by every other intent. This is decided
  // by intent (i.e. by object CLASS via the interaction contract), not
  // by hardcoding a specific object id — so this is not a special case
  // for "menu_portal" specifically, it is what ANY Portal-class object
  // does.
  if (intent === "OPEN_PORTAL") {
    bus.emit({ type: "MENU_INTENT", source, forceReject: false });
    return;
  }
  bus.emit({ type: "OBJECT_INTERACTED", objectId, source });
}
