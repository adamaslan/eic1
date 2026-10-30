import { useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { AppError, type Category, type ItemType } from "@veil/core";
import {
  LISTING_CATEGORIES,
  saveComposedItem,
  validateCompose,
  type ComposeErrors,
} from "@veil/features";
import { MAX_MEDIA_PER_ITEM } from "@veil/media";
import type { Route } from "./+types/compose";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { compressImage, UnsupportedMediaError, type CompressedImage } from "~/platform/media";
import { useSessionStore } from "~/platform/session";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "New post — Everybody is Cool" }];
}

const FIELD = "w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";

export default function Compose() {
  const vault = useSessionStore((state) => state.vault);
  const navigate = useNavigate();
  const formId = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<ItemType>("photo");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>(LISTING_CATEGORIES[0] ?? "electronics");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [shareable, setShareable] = useState(false);
  const [images, setImages] = useState<CompressedImage[]>([]);
  const [progress, setProgress] = useState<{ label: string; percent: number } | null>(null);
  const [errors, setErrors] = useState<ComposeErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handlePick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setNotice(null);
    const room = MAX_MEDIA_PER_ITEM - images.length;
    if (files.length > room) setNotice(`Only ${MAX_MEDIA_PER_ITEM} photos per post. Extra files were skipped.`);

    const added: CompressedImage[] = [];
    try {
      for (const file of files.slice(0, Math.max(0, room))) {
        try {
          added.push(await compressImage(file, (label, percent) => setProgress({ label: `${file.name}: ${label}`, percent })));
        } catch (caught) {
          setNotice(caught instanceof UnsupportedMediaError ? caught.message : "This photo could not be processed.");
        }
      }
    } finally {
      setProgress(null);
      setImages((current) => [...current, ...added]);
      setErrors((current) => ({ ...current, media: undefined }));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!vault || saving) return;
    const result = validateCompose({ type, title, category, price, description, visibility: shareable ? "shareable" : "private" }, images.length);
    setErrors(result.ok ? {} : result.errors);
    if (!result.ok) return;

    setNotice(null);
    setSaving(true);
    try {
      await saveComposedItem(vault, result.fields, images, { newId: newItemId, now: new Date() });
      navigate(type === "photo" ? "/feed" : "/market");
    } catch (caught) {
      setNotice(caught instanceof AppError ? caught.message : "The post could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Window title="New post">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-[12px] text-[#0a0a0a]" noValidate>
        <fieldset className="flex gap-4">
          <legend className="mb-1 font-bold">Post type</legend>
          {(["photo", "listing"] as const).map((option) => (
            <label key={option} className="flex items-center gap-1">
              <input
                type="radio"
                name={`${formId}-type`}
                checked={type === option}
                onChange={() => {
                  setType(option);
                  setErrors((current) => ({ ...current, media: undefined, price: undefined }));
                }}
              />
              {option === "photo" ? "Photo moment" : "Marketplace listing"}
            </label>
          ))}
        </fieldset>

        <Field label="Title" error={errors.title} htmlFor={`${formId}-title`}>
          <input id={`${formId}-title`} className={FIELD} value={title} onChange={(e) => {
            setTitle(e.target.value);
            setErrors((current) => ({ ...current, title: undefined }));
          }} />
        </Field>

        {type === "listing" && (
          <>
            <Field label="Category" htmlFor={`${formId}-category`}>
              <select
                id={`${formId}-category`}
                className={FIELD}
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                {LISTING_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Price" error={errors.price} htmlFor={`${formId}-price`} hint="Leave blank if free.">
              <input
                id={`${formId}-price`}
                className={`${FIELD} sm:w-[120px]`}
                inputMode="decimal"
                value={price}
                onChange={(e) => {
                  setPrice(e.target.value);
                  setErrors((current) => ({ ...current, price: undefined }));
                }}
              />
            </Field>
          </>
        )}

        <Field label="Notes" error={errors.description} htmlFor={`${formId}-notes`}>
          <textarea
            id={`${formId}-notes`}
            className={FIELD}
            rows={3}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setErrors((current) => ({ ...current, description: undefined }));
            }}
          />
        </Field>

        <label className="flex items-start gap-1">
          <input type="checkbox" checked={shareable} onChange={(e) => setShareable(e.target.checked)} className="mt-0.5" />
          <span>
            <b>Allow sharing this post.</b> It stays encrypted in your vault. It only leaves this device, readable by
            anyone who gets the file, if you export a share file from Connections.
          </span>
        </label>

        <div className="flex flex-col gap-1">
          <span className="font-bold">Photos</span>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={handlePick} aria-label="Choose photos" />
          <div>
            <Button95 onClick={() => fileInput.current?.click()} disabled={progress !== null || images.length >= MAX_MEDIA_PER_ITEM}>
              Add photos…
            </Button95>
          </div>
          <span className="text-[11px] text-[#404040]">Resized and compressed on this device before encryption.</span>
          {progress && (
            <div role="status" className="text-[11px]">
              {progress.label} {progress.percent}%
            </div>
          )}
          <ul className="flex flex-wrap gap-1">
            {images.map((image, index) => (
              <li key={`${image.name}-${index}`} className="flex items-center gap-1 bg-white px-1.5 py-0.5 font-mono text-[11px]">
                {image.name} · {image.reducedPercent}% smaller · 🔒
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  className="cursor-pointer px-1"
                  onClick={() => {
                    setImages((current) => current.filter((_, i) => i !== index));
                    setErrors((current) => ({ ...current, media: undefined }));
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {errors.media && <p role="alert" className="text-[#800000]">{errors.media}</p>}
        </div>

        {notice && <p role="alert" className="text-[#800000]">{notice}</p>}

        <div className="flex gap-2">
          <Button95 type="submit" disabled={saving || progress !== null}>
            {saving ? "Encrypting…" : "🔒 Encrypt & save"}
          </Button95>
          <Button95 onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </Button95>
        </div>
      </form>
    </Window>
  );
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="font-bold">
        {label}
      </label>
      {children}
      {hint && <span className="text-[11px] text-[#404040]">{hint}</span>}
      {error && <p role="alert" className="text-[#800000]">{error}</p>}
    </div>
  );
}
