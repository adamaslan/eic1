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

/** Merges an update onto the persisted settings: only fields that differ from what the
 * caller based its edit on (`base`) are written, so stale untouched fields (feedUrl set
 * up in another tab, keywords edited elsewhere) survive the save. */
export function mergeSettingsUpdate(base: Settings, next: Settings, persisted: Settings): Settings {
  const merged: Record<string, unknown> = { ...persisted };
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (!Object.is(next[key], base[key])) merged[key as string] = next[key];
  }
  return merged as Settings;
}

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
      // Write back only the fields this screen actually changed, merged onto the FRESH
      // persisted settings: another tab or relay feed setup may have written since this
      // cache loaded, and saving the caller's whole stale object would wipe fields like
      // feedUrl that the caller never touched.
      const base = loaded?.vault === vault && loaded.revision === revision ? loaded.settings : settings;
      const merged = mergeSettingsUpdate(base, next, await loadSettings(vault));
      const saved = await saveSettings(vault, merged);
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
