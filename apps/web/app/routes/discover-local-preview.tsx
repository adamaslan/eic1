import { useState } from "react";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair } from "@veil/crypto";
import { DirectoryService, SignedDirectoryClient, emptyDirectory, type DirectoryDatabase } from "@veil/features";
import { signedDirectoryAdapter } from "~/platform/discover-signed-adapter";
import { DiscoverDirectory } from "~/components/discover-directory";
import { DirectoryController, type DirectoryAdapter, type DirectoryCard } from "~/platform/discover-controller";

// Test-only route. Registered only with EIC_LOCAL_DISCOVER_PREVIEW=1; no production adapter.
const people: DirectoryCard[] = [
  { id: "synthetic-river", name: "River", handle: "river.frames", bio: "Film photos, neighborhood walks, zines." },
  { id: "synthetic-jo", name: "Jo", handle: "jo.makes", bio: "Making small games and loud playlists." },
  { id: "synthetic-sage", name: "Sage", handle: "sage.grows", bio: "Houseplants and weekend noodle experiments." },
  { id: "synthetic-kit", name: "Kit", handle: "kit.draws", bio: "Sketchbooks, tiny comics, big dogs." },
  { id: "synthetic-remy", name: "Remy", handle: "remy.rides", bio: "Bike rides to coffee shops. Always a new route." },
  { id: "synthetic-lee", name: "Lee", handle: "lee.listens", bio: "Ambient music and sci-fi book swaps." },
];
function syntheticAdapter(): DirectoryAdapter {
  // Real signatures + admission + CAS protocol in this browser only. No HTTP endpoint.
  const ready = (async () => {
    const keys = new Map<string, string>(); let generation = 0; let value: DirectoryDatabase = emptyDirectory();
    const service = new DirectoryService({
      read: async () => ({ generation: String(generation), value: structuredClone(value) }),
      compareAndSet: async (expected, next) => { if (expected !== String(generation)) return false; value = structuredClone(next); generation++; return true; },
    }, async (principal, pubkey) => keys.get(principal) === pubkey, () => Date.now());
    async function actor(id: string) {
      const identity = await generateSigningKeyPair(); keys.set(id, encodeBase64(identity.publicKey)); let seq = 0;
      return new SignedDirectoryClient(id, identity, async () => ++seq, (request) => service.execute(request), () => Date.now());
    }
    for (const person of people) { const client = await actor(person.id); await client.execute({ action: "publish", card: { name: person.name, handle: person.handle, bio: person.bio } }); }
    return signedDirectoryAdapter(await actor("synthetic-self"));
  })();
  return {
    read: async () => (await ready).read(),
    publish: async (draft) => (await ready).publish(draft),
    hide: async () => (await ready).hide(),
    request: async (id) => (await ready).request(id),
  };
}
export default function DiscoverLocalPreview() {
  const [controller] = useState(() => new DirectoryController(syntheticAdapter()));
  return <main className="min-h-screen bg-[#008080] p-2 sm:p-6"><DiscoverDirectory controller={controller} synthetic /></main>;
}
