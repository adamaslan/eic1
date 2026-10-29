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
  const [state, setState] = useState<ItemsState>({ status: "loading" });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    setState({ status: "loading" });
    vault
      .listItems()
      .then((items) => {
        if (!cancelled) setState({ status: "ready", items });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message = caught instanceof AppError ? caught.message : "This vault could not be read.";
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [vault, revision]);

  const reload = useCallback(() => setRevision((n) => n + 1), []);
  return { state, reload };
}
