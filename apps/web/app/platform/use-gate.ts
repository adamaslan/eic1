import { useEffect, useState } from "react";
import { isFeatureEnabled, loadSettings } from "@veil/features";
import type { UnlockedVault } from "@veil/vault";

// Reads one feature flag from the vault's settings. Absent key means enabled, so the
// flag reads true until settings load - nothing hides behind an unloaded state.
export function useFeatureEnabled(vault: UnlockedVault | null, feature: string): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    loadSettings(vault).then((settings) => {
      if (!cancelled) setEnabled(isFeatureEnabled(settings, feature));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vault, feature]);
  return enabled;
}
