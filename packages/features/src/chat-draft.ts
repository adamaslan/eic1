import { z } from "zod";
import type { UnlockedVault } from "@veil/vault";
import { CHAT_BODY_MAX } from "./chat";

// The unsent text in a chat's message box, kept as a separate encrypted settings record so a reload does not
// lose it. Chat and relay code only list "chat" records, so a draft is never published or shown as a message.
const id = (threadAuthorId: string) => `chat-draft:${threadAuthorId}`;
const ChatDraftSchema = z.object({ v: z.literal(1), body: z.string().min(1).max(CHAT_BODY_MAX) });

/** The saved draft for one chat, or "" when there is none or it cannot be read. */
export async function loadChatDraft(vault: UnlockedVault, threadAuthorId: string): Promise<string> {
  const parsed = ChatDraftSchema.safeParse(await vault.getJson(id(threadAuthorId)));
  return parsed.success ? parsed.data.body : "";
}

/** Saves the box as it is. Blank text removes the record, so a sent or cleared draft leaves nothing behind. */
export async function saveChatDraft(vault: UnlockedVault, threadAuthorId: string, body: string): Promise<void> {
  if (!body.trim()) { await vault.deleteRecords([id(threadAuthorId)]); return; }
  await vault.putJson("settings", id(threadAuthorId), ChatDraftSchema.parse({ v: 1, body: body.slice(0, CHAT_BODY_MAX) }));
}
