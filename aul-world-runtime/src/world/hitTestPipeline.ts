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
  bus.emit({ type: "OBJECT_INTERACTED", objectId, source });
}
