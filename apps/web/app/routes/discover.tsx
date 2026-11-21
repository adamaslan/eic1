import { useEffect, useState, useSyncExternalStore } from "react";
import { configureRelayFeed, createRelayTransport, joinRelaySelf, loadSettings, vaultDirectoryClient } from "@veil/features";
import { RelayJoin } from "~/components/relay-join";
import { DiscoverDirectory } from "~/components/discover-directory";
import { DirectoryController } from "~/platform/discover-controller";
import { signedDirectoryAdapter } from "~/platform/discover-signed-adapter";
import { useSessionStore } from "~/platform/session";
import { Window } from "~/ui95/Window";

// Real Discover: signed requests to the relay's directory action. Visibility is hidden by default and
// only the owner's chosen fields are published (see DiscoverDirectory). Being listed never lets anyone
// message you: a request must be accepted, and accepting is separate from chatting.
/** The join check is only for people the relay does not know yet. Once Discover has loaded they are in, so it goes away. */
function JoinGate({ controller, children }: { controller: DirectoryController | null; children: React.ReactNode }) {
  const ready = useSyncExternalStore(
    (listener) => (controller ? controller.subscribe(listener) : () => {}),
    () => controller?.snapshot().ready ?? false,
    () => false,
  );
  return ready ? null : <>{children}</>;
}

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
        // A connect sealed before this vault has a relay feed would leave the friend with nothing to pull from.
        const prepareFeed = async () => { if (!(await loadSettings(vault)).feedUrl) await configureRelayFeed(vault, endpoint); };
        const next = new DirectoryController(signedDirectoryAdapter(client, vault, prepareFeed));
        if (!cancelled) { setController(next); void next.load(); }
      } catch (caught) {
        if (!cancelled) setProblem(caught instanceof Error ? caught.message : "Discover is unavailable right now.");
      }
    })();
    return () => { cancelled = true; };
  }, [vault, endpoint]);

  // DiscoverDirectory draws its own "Discover" window, so the route adds one only while there is no directory yet.
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-3">
      {endpoint && vault && (
        <JoinGate controller={controller}>
          <Window title="Join Discover">
            <RelayJoin onJoin={async (token) => {
              await joinRelaySelf(vault, endpoint, token);
              await controller?.load();
            }} />
          </Window>
        </JoinGate>
      )}
      {controller ? <DiscoverDirectory controller={controller} /> : <Window title="Discover"><p className="text-[12px]">{problem ?? "Connecting to Discover…"}</p></Window>}
    </div>
  );
}
