import { useEffect, useState, type FormEvent } from "react";
import { AppError } from "@veil/core";
import type { Route } from "./+types/unlock";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { Link } from "react-router";
import { vaultCreate, vaultExists, vaultUnlock } from "~/platform/vault-service";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Vault — Veil 95" }];
}

const MIN_PASSPHRASE_LENGTH = 8;
const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";

export default function Unlock() {
  const vault = useSessionStore((state) => state.vault);
  const setVault = useSessionStore((state) => state.setVault);
  const lock = useSessionStore((state) => state.lock);

  const [exists, setExists] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [readBack, setReadBack] = useState<string | null>(null);

  useEffect(() => {
    vaultExists().then(setExists);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!exists && passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (!exists && passphrase !== confirm) {
      setError("The two passphrases do not match.");
      return;
    }

    setBusy(true);
    try {
      const opened = exists ? await vaultUnlock(passphrase) : await vaultCreate(passphrase);
      setVault(opened);
      setPassphrase("");
      setConfirm("");
    } catch (caught) {
      if (!(caught instanceof AppError)) throw caught;
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    if (!vault || !note.trim()) return;
    setError(null);
    try {
      const id = await vault.putRecord("item", new TextEncoder().encode(note));
      const bytes = await vault.getRecord(id);
      setReadBack(bytes ? new TextDecoder().decode(bytes) : null);
      setNote("");
    } catch (caught) {
      if (!(caught instanceof AppError)) throw caught;
      setError(caught.message);
    }
  }

  return (
    <main className="min-h-screen bg-[#008080] p-3">
      <Window title="Vault — encrypted local storage">
        {exists === null && <p className="text-[12px]">Checking this device…</p>}

        {exists !== null && !vault && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-2 text-[12px]">
            <p>
              {exists
                ? "Enter your passphrase to unlock the vault."
                : "No vault yet. Choose a passphrase. It is never sent anywhere, and if you lose it the data cannot be recovered."}
            </p>
            <label className="flex flex-col gap-0.5">
              Passphrase
              <input
                type="password"
                autoComplete={exists ? "current-password" : "new-password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className={inputClass}
                required
              />
            </label>
            {!exists && (
              <label className="flex flex-col gap-0.5">
                Confirm passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={inputClass}
                  required
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-[#800000]">
                {error}
              </p>
            )}
            <Button95 type="submit" disabled={busy} className="self-start">
              {exists ? "Unlock" : "Create vault"}
            </Button95>
          </form>
        )}

        {vault && (
          <div className="flex flex-col gap-2 text-[12px]">
            <p>Unlocked. Notes are encrypted before they reach storage.</p>
            <label className="flex flex-col gap-0.5">
              Test note
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className={inputClass}
              />
            </label>
            <div className="flex gap-2">
              <Button95 onClick={saveNote}>Save note</Button95>
              <Button95 onClick={lock}>Lock</Button95>
            </div>
            {readBack !== null && (
              <p>
                Read back from encrypted storage: <strong>{readBack}</strong>
              </p>
            )}
            {error && (
              <p role="alert" className="text-[#800000]">
                {error}
              </p>
            )}
          </div>
        )}

        <p className="mt-3">
          <Link to="/" className="text-[#0000cc] underline">
            Back to desktop
          </Link>
        </p>
      </Window>
    </main>
  );
}
