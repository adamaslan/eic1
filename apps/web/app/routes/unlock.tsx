import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { AppError } from "@veil/core";
import type { Route } from "./+types/unlock";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { Link, Navigate, useNavigate } from "react-router";
import { vaultCreate, vaultExists, vaultImport, vaultUnlock } from "~/platform/vault-service";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Vault — Everybody is Cool" }];
}

const MIN_PASSPHRASE_LENGTH = 8;
const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";

export default function Unlock() {
  const vault = useSessionStore((state) => state.vault);
  const setVault = useSessionStore((state) => state.setVault);
  const navigate = useNavigate();

  const [exists, setExists] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    vaultExists()
      .then((vaultFound) => {
        if (!cancelled) setExists(vaultFound);
      })
      .catch(() => {
        if (!cancelled) setError("Storage is unavailable in this browser. The vault cannot be opened.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRestore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const { records } = await vaultImport(await file.text());
      setRestored(records);
      setExists(true);
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The backup could not be read or restored.");
    } finally {
      setBusy(false);
    }
  }

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
      navigate("/feed", { replace: true });
      setPassphrase("");
      setConfirm("");
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The vault could not be opened. Check browser storage and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (vault) {
    return <Navigate to="/feed" replace />;
  }

  return (
    <main className="min-h-screen bg-[#008080] p-3">
      <Window title="Vault — encrypted local storage">
        {exists === null && <p className="text-[12px]">Checking this device…</p>}
        {exists === null && error && <p role="alert" className="text-[12px] text-[#800000]">{error}</p>}

        {exists !== null && !vault && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-2 text-[12px]">
            {restored !== null && (
              <p role="status">Backup restored ({restored} records). Enter the passphrase it was created with.</p>
            )}
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

        {exists === false && !vault && (
          <label className="mt-3 flex flex-col gap-0.5 text-[12px]">
            Restore from backup
            <input type="file" accept=".vault,application/json" onChange={handleRestore} disabled={busy} />
          </label>
        )}

        <p className="mt-3">
          <Link to="/" className="text-[#0000cc] underline">
            Back to home
          </Link>
        </p>
      </Window>
    </main>
  );
}
