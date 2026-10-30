import { useCallback, useEffect, useState } from "react";
import type { Connection, Note, Settings } from "@veil/core";
import {
  defaultSettings,
  listConnections,
  listNotes,
  loadSettings,
  saveSettings,
  useVaultItems,
  type ItemsState,
} from "@veil/features";
import type { UnlockedVault } from "@veil/vault";

export interface Social {
  items: ItemsState;
  settings: Settings;
  notes: Note[];
  connections: Connection[];
  /** Saves new settings and updates the screen. */
  update: (next: Settings) => Promise<void>;
  /** Re-reads items, notes, and connections after something wrote to the vault. */
  refresh: () => void;
}

// Everything the landing dashboard and the connections screen read from the vault, kept in one place.
export function useSocial(vault: UnlockedVault | null): Social {
  const { state: items, reload } = useVaultItems(vault);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [notes, setNotes] = useState<Note[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    Promise.all([loadSettings(vault), listNotes(vault), listConnections(vault)])
      .then(([loadedSettings, loadedNotes, loadedConnections]) => {
        if (cancelled) return;
        setSettings(loadedSettings);
        setNotes(loadedNotes);
        setConnections(loadedConnections);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vault, revision]);

  const update = useCallback(
    async (next: Settings) => {
      if (!vault) return;
      setSettings(await saveSettings(vault, next));
    },
    [vault],
  );
  const refresh = useCallback(() => {
    reload();
    setRevision((n) => n + 1);
  }, [reload]);

  return { items, settings, notes, connections, update, refresh };
}
