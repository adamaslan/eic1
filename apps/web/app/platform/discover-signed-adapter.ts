import { SignedDirectoryClient } from "@veil/features";
import type { DirectoryAdapter } from "./discover-controller";

// Real signing/protocol client, with an injected transport only. No default/live endpoint.
// The application must confirm endpoint + authority before supplying a hosted transport.
export function signedDirectoryAdapter(client: SignedDirectoryClient): DirectoryAdapter {
  return {
    read: async () => {
      const data = await client.execute({ action: "read" });
      return { cards: data.cards, ownCard: data.ownCard };
    },
    publish: async (card) => {
      const data = await client.execute({ action: "publish", card });
      if (!data.ownCard) throw new Error("Listing was not confirmed.");
      return data.ownCard;
    },
    hide: async () => {
      const data = await client.execute({ action: "hide" });
      if (data.ownCard) throw new Error("Hiding was not confirmed.");
    },
    request: async (target) => {
      const data = await client.execute({ action: "request", target });
      const request = data.requests.find((request) => request.to === target);
      if (!request || request.status !== "pending") throw new Error("No pending request was confirmed.");
    },
  };
}
