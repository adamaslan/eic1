import { useCallback, useEffect, useState } from "react";
import type { Connection, Note, Settings } from "@veil/core";
import {
  changedSettingsFields,
  defaultSettings,
  listConnections,
  listNotes,
  loadSettings,
  saveSettingsFields,
  useVaultItems,
  type ItemsState,
} from "@veil/features";
import type { UnlockedVault } from "@veil/vault";

export interface Social {
  items: ItemsState;
  settings: Settings;
  settingsReady: boolean;
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
  const [loaded, setLoaded] = useState<{ vault: UnlockedVault; revision: number; settings: Settings } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    loadSettings(vault).then((settings) => {
      if (!cancelled) setLoaded({ vault, revision, settings });
    }).catch(() => undefined);
    listNotes(vault).then((notes) => {
      if (!cancelled) setNotes(notes);
    }).catch(() => undefined);
    listConnections(vault).then((connections) => {
      if (!cancelled) setConnections(connections);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vault, revision]);

  const settingsReady = !!vault && loaded?.vault === vault && loaded.revision === revision;
  const settings = loaded?.vault === vault ? loaded.settings : defaultSettings();

  const update = useCallback(
    async (next: Settings) => {
      if (!vault || !settingsReady) return;
      // Write back only the fields this screen actually changed, applied onto the FRESH
      // record inside the save's CAS loop: another tab or relay feed setup may write at
      // any moment, and merging onto any pre-load snapshot would revert fields like
      // feedUrl that the caller never touched.
      const base = loaded?.vault === vault && loaded.revision === revision ? loaded.settings : settings;
      const saved = await saveSettingsFields(vault, changedSettingsFields(base, next));
      setLoaded((current) => current?.vault === vault && current.revision > revision
        ? current
        : { vault, revision, settings: saved });
    },
    [vault, revision, settingsReady, loaded, settings],
  );
  const refresh = useCallback(() => {
    reload();
    setRevision((n) => n + 1);
  }, [reload]);

  return { items, settings, settingsReady, notes, connections, update, refresh };
}
