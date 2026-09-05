// Asset boundary (domain-safe side). Domain/world modules refer to
// placeholder visuals only by this kind of plain identifier — never by
// a PixiJS Texture, Sprite, or any renderer-owned resource. The actual
// "loaded resource" cache lives inside the renderer adapter
// (see render/adapter/pixiRendererAdapter.ts), not here and not
// scattered through domain code.

export interface PlaceholderAssetDescriptor {
  shape: "circle";
  radius: number;
  colorHex: number;
}

// In this prototype the "asset identifier" is simply derived from the
// render object's own radius/color, since placeholder shapes are
// generated, not loaded from files. A real asset system would instead
// map a stable string id (e.g. "aul.idle.v1") to a descriptor here;
// swapping that in later does not require touching the renderer
// adapter's caching mechanism.
export function descriptorKey(descriptor: PlaceholderAssetDescriptor): string {
  return `${descriptor.shape}:${descriptor.radius}:${descriptor.colorHex}`;
}
