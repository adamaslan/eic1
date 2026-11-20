import { useEffect, useState } from "react";
import { createRelayTransport, vaultDirectoryClient } from "@veil/features";
import { DiscoverDirectory } from "~/components/discover-directory";
import { DirectoryController } from "~/platform/discover-controller";
import { signedDirectoryAdapter } from "~/platform/discover-signed-adapter";
import { useSessionStore } from "~/platform/session";
import { Window } from "~/ui95/Window";

// Real Discover: signed requests to the relay's directory action. Visibility is hidden by default and
// only the owner's chosen fields are published (see DiscoverDirectory). Being listed never lets anyone
// message you: a request must be accepted, and accepting is separate from chatting.
export default function DiscoverRoute() {
  const vault = useSessionStore((state) => state.vault);
  const endpoint = import.meta.env.VITE_EIC_RELAY_ENDPOINT as string | undefined;
  const [controller, setController] = useState<DirectoryController | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!vault) return;
    if (!endpoint) { setProblem("Discover needs the encrypted relay, which this build does not have configured."); return; }
    let cancelled = false;
    void (async () => {
      try {
        const client = await vaultDirectoryClient(vault, (envelope) => createRelayTransport(endpoint).directory(envelope), () => Date.now());
        const next = new DirectoryController(signedDirectoryAdapter(client));
        if (!cancelled) { setController(next); void next.load(); }
      } catch (caught) {
        if (!cancelled) setProblem(caught instanceof Error ? caught.message : "Discover is unavailable right now.");
      }
    })();
    return () => { cancelled = true; };
  }, [vault, endpoint]);

  return (
    <Window title="Discover">
      {controller ? <DiscoverDirectory controller={controller} /> : <p className="text-[12px]">{problem ?? "Connecting to Discover…"}</p>}
    </Window>
  );
}
