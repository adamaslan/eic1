/**
 * Where to go after unlocking: the screen that sent the person to /unlock, carried in router
 * history state. Only same-app paths are accepted; anything else falls back to the home screen.
 */
export function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//") || from.startsWith("/unlock")) return "/";
  return from;
}
