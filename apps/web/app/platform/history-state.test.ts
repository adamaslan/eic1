import { describe, expect, it, vi } from "vitest";
import { clearSavedNoticeFromHistory } from "./history-state";

describe("clearSavedNoticeFromHistory", () => {
  it("removes only the saved flag and preserves other user and router state", () => {
    const replaceState = vi.fn();
    const history = {
      state: { usr: { saved: true, source: "compose" }, key: "entry-key", idx: 4 },
      replaceState,
    } as unknown as History;

    clearSavedNoticeFromHistory(history, null);

    expect(replaceState).toHaveBeenCalledWith({
      usr: { source: "compose" },
      key: "entry-key",
      idx: 4,
    }, "");
  });

  it("clears user state only when it contains no other fields", () => {
    const replaceState = vi.fn();
    const history = { state: { usr: { saved: true }, key: "entry-key", idx: 4 }, replaceState } as unknown as History;
    clearSavedNoticeFromHistory(history, null);
    expect(replaceState).toHaveBeenCalledWith({ usr: null, key: "entry-key", idx: 4 }, "");
  });
});
