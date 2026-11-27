import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { AppError } from "@veil/core";
import type { Route } from "./+types/unlock";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { vaultCreate, vaultExists, vaultImport, vaultUnlock } from "~/platform/vault-service";
import { useSessionStore } from "~/platform/session";
import { SignInNav } from "~/components/sign-in-nav";
import { returnPath } from "~/platform/return-path";
import { IDLE_MINUTES, type IdleMinutes } from "~/platform/session-policy";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Vault — Everybody is Cool" }];
}

const MIN_PASSPHRASE_LENGTH = 8;
const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[var(--w95-ink)] outline-none";

export default function Unlock() {
  const vault = useSessionStore((state) => state.vault);
  const setVault = useSessionStore((state) => state.setVault);
  const navigate = useNavigate();
  const destination = returnPath(useLocation().state);

  const [exists, setExists] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [privateDevice, setPrivateDevice] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState<IdleMinutes>(60);
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
      const policy = { privateDevice, idleMinutes };
      const opened = exists ? await vaultUnlock(passphrase, policy) : await vaultCreate(passphrase, policy);
      setVault(opened.vault, opened.expiresAt, opened.lockMarker, opened.timing);
      navigate(destination, { replace: true });
      setPassphrase("");
      setConfirm("");
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The vault could not be opened. Check browser storage and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (vault) {
    return <Navigate to={destination} replace />;
  }

  return (
    <main className="w95-desktop min-h-screen p-3">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <SignInNav />
      <div className="w-full max-w-xl self-center">
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
            <fieldset className="flex flex-col gap-2 border border-[var(--w95-ink)] p-2" disabled={busy}>
              <legend className="px-1">Stay signed in on this browser</legend>
              <label className="flex min-h-[44px] items-center gap-2">
                <input type="checkbox" checked={privateDevice} onChange={(event) => setPrivateDevice(event.target.checked)} className="h-5 w-5 shrink-0" />
                <span>Remember for up to 30 days, only on my private device</span>
              </label>
              <label className="flex flex-col gap-1">
                Lock after no activity
                <select value={idleMinutes} onChange={(event) => setIdleMinutes(Number(event.target.value) as IdleMinutes)} className={`${inputClass} min-h-[44px]`}>
                  {IDLE_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{minutes === 15 ? "15 minutes" : minutes === 60 ? "1 hour (default)" : minutes === 480 ? "8 hours" : "24 hours"}</option>)}
                </select>
              </label>
              <p role="note">{privateDevice ? "Up to 30 days" : "Up to 8 hours"} from this unlock, never extended by reloads. The idle timer or Manual Lock can end it sooner. Anyone using this browser while unlocked can open your private vault. Do not choose a longer window on a shared device. Browser storage may be cleared or unavailable.</p>
            </fieldset>
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
          <Link to="/" className="text-[var(--w95-link)] underline">
            Back to home
          </Link>
        </p>
      </Window>
      </div>
      </div>
    </main>
  );
}
