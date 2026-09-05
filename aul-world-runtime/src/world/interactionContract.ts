import type { ObjectClass } from "../state/types";

export type Intent = "FOCUS_CHARACTER" | "OPEN_PORTAL" | "TOUCH_DECORATION" | "NONE";

// Interaction contract: what kind of intent a given object CLASS may
// produce when interacted with. Class-based (not per-object), so a new
// decorative prop never requires touching behavior code, and a new
// Character automatically supports focus interaction.
export function intentFor(objectClass: ObjectClass): Intent {
  switch (objectClass) {
    case "Character":
      return "FOCUS_CHARACTER";
    case "Portal":
      return "OPEN_PORTAL";
    case "Reactive":
      return "TOUCH_DECORATION";
    case "Decorative":
    case "Event":
      return "NONE";
  }
}
