// Shared world/canvas constants. Kept in one place after the camera-
// math bug found during AWR-01 verification (WORLD_VIEW's "at rest"
// target silently drifting out of sync with the renderer's canvas
// center caused objects and hit-testing to land off-screen).
export const VIEW_WIDTH = 640;
export const VIEW_HEIGHT = 400;
export const WORLD_CENTER_X = VIEW_WIDTH / 2;
export const WORLD_CENTER_Y = VIEW_HEIGHT / 2;
