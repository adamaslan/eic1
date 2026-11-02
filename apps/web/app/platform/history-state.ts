/** Removes only the one-shot save flag, preserving other route state and router metadata. */
export function clearSavedNoticeFromHistory(history: Pick<History, "state" | "replaceState">, fallbackState: unknown): void {
  const current = history.state && typeof history.state === "object"
    ? history.state as Record<string, unknown>
    : {};
  const userState = ("usr" in current ? current.usr : fallbackState) as Record<string, unknown> | null;
  const remaining = userState && typeof userState === "object" && !Array.isArray(userState)
    ? { ...userState }
    : {};
  delete remaining.saved;
  history.replaceState({
    ...current,
    usr: Object.keys(remaining).length > 0 ? remaining : null,
  }, "");
}
