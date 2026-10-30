import { useCallback, useEffect, useState } from "react";
import { AppError, type Item } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

export type ItemsState =
  | { status: "loading" }
  | { status: "ready"; items: Item[] }
  | { status: "error"; message: string };

export interface VaultItems {
  state: ItemsState;
  reload: () => void;
}

export function useVaultItems(vault: UnlockedVault | null): VaultItems {
  const [loaded, setLoaded] = useState<{ vault: UnlockedVault | null; state: ItemsState }>({
    vault: null, state: { status: "loading" },
  });
  const state: ItemsState = loaded.vault === vault ? loaded.state : { status: "loading" };
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    setLoaded((current) => current.vault === vault && current.state.status === "ready"
      ? current
      : { vault, state: { status: "loading" } });
    vault
      .listItems()
      .then((items) => {
        if (!cancelled) setLoaded({ vault, state: { status: "ready", items } });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message = caught instanceof AppError ? caught.message : "This vault could not be read.";
        setLoaded({ vault, state: { status: "error", message } });
      });
    return () => {
      cancelled = true;
    };
  }, [vault, revision]);

  const reload = useCallback(() => setRevision((n) => n + 1), []);
  return { state, reload };
}
