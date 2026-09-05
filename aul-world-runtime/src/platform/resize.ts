// Minimal platform/infrastructure concern: keep the fixed-resolution
// canvas visually scaled to fit its wrapper on resize, without the
// renderer or domain layers needing to know about window size at all.
export function attachResponsiveScale(wrapper: HTMLElement, canvasNativeWidth: number): () => void {
  function apply() {
    const scale = Math.min(1, wrapper.clientWidth / canvasNativeWidth);
    const canvas = wrapper.querySelector("canvas");
    if (canvas) {
      (canvas as HTMLCanvasElement).style.transformOrigin = "top left";
      (canvas as HTMLCanvasElement).style.transform = `scale(${scale})`;
    }
  }
  window.addEventListener("resize", apply);
  apply();
  return () => window.removeEventListener("resize", apply);
}
