import { z } from "zod";
import { AppError } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

// A local, encrypted list of people I blocked in Discover. Nothing about a block is sent to the relay or to the
// person: Discover hides their card here and declines their requests through the ordinary decline action.
// Existing connections and chats are left alone. There is no report, because there is no one to send it to.
const RECORD_ID = "discover-blocks";
export const DISCOVER_BLOCK_MAX = 500;
const BlockedSchema = z.object({ id: z.string().min(1).max(256), name: z.string().max(40), handle: z.string().max(30) });
const BlocksSchema = z.object({ v: z.literal(1), people: z.array(BlockedSchema).max(DISCOVER_BLOCK_MAX) });
export type BlockedPerson = z.infer<typeof BlockedSchema>;

export async function listDiscoverBlocks(vault: UnlockedVault): Promise<BlockedPerson[]> {
  const parsed = BlocksSchema.safeParse(await vault.getJson(RECORD_ID));
  return parsed.success ? parsed.data.people : [];
}

async function change(vault: UnlockedVault, edit: (people: BlockedPerson[]) => BlockedPerson[]): Promise<BlockedPerson[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await vault.getJson(RECORD_ID);
    const parsed = BlocksSchema.safeParse(raw);
    const people = BlocksSchema.parse({ v: 1, people: edit(parsed.success ? parsed.data.people : []) }).people;
    try {
      await vault.putJsonIfUnchanged("settings", RECORD_ID, { v: 1, people }, raw);
      return people;
    } catch {
      // Another tab changed the list first; retry against the fresh record.
    }
  }
  throw new AppError("Your block list changed while saving. Try again.");
}

export function blockDiscoverPerson(vault: UnlockedVault, person: BlockedPerson): Promise<BlockedPerson[]> {
  return change(vault, (people) => {
    if (people.some((p) => p.id === person.id)) return people;
    if (people.length >= DISCOVER_BLOCK_MAX) throw new AppError(`You can block up to ${DISCOVER_BLOCK_MAX} people.`);
    return [...people, BlockedSchema.parse(person)];
  });
}

export function unblockDiscoverPerson(vault: UnlockedVault, id: string): Promise<BlockedPerson[]> {
  return change(vault, (people) => people.filter((p) => p.id !== id));
}
