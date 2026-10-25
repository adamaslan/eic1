import { useEffect, useState } from "react";
import type { UnlockedVault } from "@veil/vault";

// Decrypts one record into a blob: URL for <img>, and revokes it on unmount so
// plaintext does not outlive the screen that shows it.
export function useMediaUri(vault: UnlockedVault | null, recordId: string | null, mime: string): string | null {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    if (!vault || !recordId) {
      setUri(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    vault
      .getRecord(recordId)
      .then((bytes) => {
        if (cancelled || !bytes) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setUri(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUri(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [vault, recordId, mime]);

  return uri;
}
