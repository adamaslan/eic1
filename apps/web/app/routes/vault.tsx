import { useState } from "react";
import { useNavigate } from "react-router";
import { AppError } from "@veil/core";
import { useVaultItems } from "@veil/features";
import type { Route } from "./+types/vault";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { downloadTextFile } from "~/platform/download";
import { useSessionStore } from "~/platform/session";

import { vaultExport, vaultWipe } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Vault — Everybody is Cool" }];
}

const WIPE_PHRASE = "WIPE";

export default function VaultScreen() {
  const vault = useSessionStore((state) => state.vault);
  const lock = useSessionStore((state) => state.lock);
  const navigate = useNavigate();
  const { state } = useVaultItems(vault);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");

  async function handleExport() {
    setError(null);
    try {
      const day = new Date().toISOString().slice(0, 10);
      downloadTextFile(`eic-${day}.vault`, await vaultExport());
      setNotice("Backup downloaded. It is encrypted; you still need your passphrase to open it.");
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The backup could not be created.");
    }
  }

  async function handleWipe() {
    setError(null);
    if (!vault) return;
    try {
      await vaultWipe(vault);
      lock();
      navigate("/unlock", { replace: true });
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The vault could not be wiped. Your current session is still open.");
    }
  }

  const count = state.status === "ready" ? state.items.length : null;

  return (
    <Window title="Vault — encrypted local storage">
      <div className="flex flex-col gap-3 text-[12px]">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Items</dt>
          <dd className="font-bold">{count ?? "…"}</dd>
          <dt>Cipher</dt>
          <dd className="font-mono">AES-256-GCM</dd>
          <dt>Key derivation</dt>
          <dd className="font-mono">PBKDF2 · SHA-256</dd>
          <dt>Auto-lock</dt>
          <dd>After 60 minutes idle, or 8 hours from unlocking. Activity resets the idle timer, not the 8-hour limit. Reload does not extend that limit. Lock ends it sooner. This browser may clear or refuse saved sessions.</dd>
        </dl>

        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="text-[#800000]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button95 onClick={handleExport}>Export encrypted backup</Button95>
          <Button95 onClick={lock}>Lock now</Button95>
        </div>
        <p className="text-[#404040]">
          To restore a backup on another browser, choose “Restore from backup” on that browser’s unlock screen.
        </p>

        <fieldset className="flex flex-col gap-2 border border-[#808080] p-2">
          <legend className="px-1 font-bold text-[#800000]">Danger zone</legend>
          {!confirming ? (
            <Button95 onClick={() => setConfirming(true)} className="self-start">
              Wipe all local data…
            </Button95>
          ) : (
            <div className="flex flex-col gap-2">
              <p>
                This deletes the vault and every item on this device. Without a backup it cannot be recovered. Type{" "}
                <b>{WIPE_PHRASE}</b> to confirm.
              </p>
              <input
                aria-label={`Type ${WIPE_PHRASE} to confirm`}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
              />
              <div className="flex gap-2">
                <Button95 onClick={handleWipe} disabled={phrase !== WIPE_PHRASE}>
                  Wipe now
                </Button95>
                <Button95
                  onClick={() => {
                    setConfirming(false);
                    setPhrase("");
                  }}
                >
                  Cancel
                </Button95>
              </div>
            </div>
          )}
        </fieldset>
      </div>
    </Window>
  );
}
