// AWR-05 Gate 1: explicit numeric depth model, replacing the categorical
// DepthLayer union ("background"/"midground"/"foreground") with a single
// integer scale from Z0 (far background) to Z60 (ambient), per the
// locked AWR-01 rendering hierarchy.
//
// DepthZ is a branded number: plain `number`s cannot be assigned to it
// directly (TypeScript will reject `const z: DepthZ = 30`), so every
// value entering domain state must go through the runtime validator
// below, keeping "is this actually a valid depth" a single, explicit
// checkpoint rather than an assumption scattered across call sites.

export const DEPTH_MIN = 0;
export const DEPTH_MAX = 60;

declare const depthZBrand: unique symbol;
export type DepthZ = number & { readonly [depthZBrand]: true };

export function asDepthZ(value: number): DepthZ {
  if (!Number.isInteger(value)) {
    throw new RangeError(`DepthZ must be an integer, got ${value}`);
  }
  if (value < DEPTH_MIN || value > DEPTH_MAX) {
    throw new RangeError(`DepthZ must be within ${DEPTH_MIN}..${DEPTH_MAX}, got ${value}`);
  }
  return value as DepthZ;
}

// AWR-05 Gate 3: numeric-depth-derived parallax factor. This lives here
// (not in the renderer adapter) because it is a pure function of the
// domain's own DepthZ scale, not a rendering-foundation concern — the
// adapter only ever imports and calls it, it does not define its own
// depth-to-parallax mapping.
export function depthParallaxFactor(z: DepthZ): number {
  if (z < 20) return 0.25;
  if (z < 40) return 0.6;
  return 1.0;
}
