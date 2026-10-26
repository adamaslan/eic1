import { useState } from "react";
import { seedDemoItems } from "@veil/features";
import { Button95 } from "~/ui95/Button95";
import { useSessionStore } from "~/platform/session";

interface DemoSeedProps {
  onSeeded: () => void;
}

// Development builds only. Production bundles never render this.
export function DemoSeed({ onSeeded }: DemoSeedProps) {
  const vault = useSessionStore((state) => state.vault);
  const [busy, setBusy] = useState(false);

  if (!import.meta.env.DEV || !vault) {
    return null;
  }

  async function handleSeed() {
    if (!vault) return;
    setBusy(true);
    try {
      await seedDemoItems(vault, new Date());
      onSeeded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button95 onClick={handleSeed} disabled={busy}>
      Load demo items
    </Button95>
  );
}
