import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { Link, useNavigate } from "react-router";
import { AppError, type Bytes } from "@veil/core";
import { PHOTO_CATEGORY, saveComposedItem, type ComposedMedia } from "@veil/features";
import type { Route } from "./+types/draw";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "untitled - Paint — Everybody is Cool" }];
}

// Small on purpose: a 320px canvas with a flat palette compresses to a few KB, so a drawing
// usually fits inside a share-one-post link (8000-char cap) instead of needing a share file.
const CANVAS_SIZE = 320;
const PALETTE = [
  "#000000", "#808080", "#800000", "#808000", "#008000", "#008080", "#000080", "#800080",
  "#ffffff", "#c0c0c0", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff",
] as const;
const BRUSHES = [3, 7, 14] as const;
const FORMATS = [
  { id: "png", mime: "image/png", label: "PNG", hint: "crisp lines" },
  { id: "jpeg", mime: "image/jpeg", label: "JPG", hint: "smallest" },
] as const;
const JPEG_QUALITY = 0.85;

type FormatId = (typeof FORMATS)[number]["id"];
const mimeFor = (format: FormatId) => FORMATS.find((candidate) => candidate.id === format)?.mime ?? "image/png";

async function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Bytes> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new AppError("This browser could not encode the drawing.");
  return new Uint8Array(await blob.arrayBuffer());
}

const formatKb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

export default function Draw() {
  const vault = useSessionStore((state) => state.vault);
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const [color, setColor] = useState<string>(PALETTE[0]);
  const [brush, setBrush] = useState<number>(BRUSHES[1]);
  const [format, setFormat] = useState<FormatId>("png");
  const [title, setTitle] = useState("");
  const [shareable, setShareable] = useState(false);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const canvasPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * canvas.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * canvas.height),
    };
  };

  const refreshSize = async (targetFormat: FormatId = format) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const bytes = await encodeCanvas(canvas, mimeFor(targetFormat), targetFormat === "jpeg" ? JPEG_QUALITY : undefined);
      setSizeBytes(bytes.length);
    } catch {
      setSizeBytes(null);
    }
  };

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (saving) return;
    drawing.current = true;
    last.current = canvasPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    drawSegment(event);
  };

  const drawSegment = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const point = canvasPoint(event);
    const from = last.current ?? point;
    context.strokeStyle = color;
    context.lineWidth = brush;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    last.current = point;
  };

  const endStroke = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    void refreshSize();
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    void refreshSize();
  };

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!vault || !canvas || saving) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setNotice("Give the drawing a title.");
      return;
    }
    setNotice(null);
    setSaving(true);
    try {
      const mime = mimeFor(format);
      const quality = format === "jpeg" ? JPEG_QUALITY : undefined;
      const bytes = await encodeCanvas(canvas, mime, quality);
      const thumb = await encodeCanvas(canvas, mime, quality);
      const media: ComposedMedia[] = [{ bytes, thumb, mime }];
      await saveComposedItem(
        vault,
        { type: "photo", title: trimmed, category: PHOTO_CATEGORY, priceCents: null, description: "", visibility: shareable ? "shareable" : "private" },
        media,
        { newId: newItemId, now: new Date() },
      );
      navigate("/feed");
    } catch (caught) {
      setNotice(caught instanceof AppError ? caught.message : "The drawing could not be saved. Please try again.");
      setSaving(false);
    }
  }

  return (
    <Window title="untitled - Paint">
      <form onSubmit={handleSave} className="flex flex-col gap-2 text-[12px] text-[#0a0a0a]" noValidate>
        <p className="text-[#404040]">
          Small canvas, flat colors: drawings stay a few KB, saved as {format === "png" ? "PNG" : "JPG"}.
        </p>
        <div className="flex items-start gap-2">
          <div className="flex flex-col gap-1 pt-0.5">
            {BRUSHES.map((option) => (
              <Button95 key={option} pressed={brush === option} onClick={() => setBrush(option)}>
                {option}px
              </Button95>
            ))}
            <Button95 onClick={clearCanvas}>Clear</Button95>
          </div>
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="touch-none bg-white"
            style={{
              width: CANVAS_SIZE,
              height: CANVAS_SIZE,
              cursor: "crosshair",
              borderTop: "2px solid #808080",
              borderLeft: "2px solid #808080",
              borderRight: "2px solid #ffffff",
              borderBottom: "2px solid #ffffff",
            }}
            onPointerDown={startStroke}
            onPointerMove={drawSegment}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
          />
        </div>
        <div className="flex flex-wrap items-center gap-0.5">
          {PALETTE.map((option) => (
            <button
              key={option}
              type="button"
              aria-label={`Color ${option}`}
              onClick={() => setColor(option)}
              className="h-4 w-4"
              style={{
                background: option,
                borderTop: color === option ? "2px solid #808080" : "1px solid #ffffff",
                borderLeft: color === option ? "2px solid #808080" : "1px solid #ffffff",
                borderRight: color === option ? "2px solid #808080" : "1px solid #808080",
                borderBottom: color === option ? "2px solid #808080" : "1px solid #808080",
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <fieldset className="flex items-center gap-2">
            <legend className="sr-only">Image format</legend>
            {FORMATS.map((option) => (
              <label key={option.id} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="draw-format"
                  checked={format === option.id}
                  onChange={() => {
                    setFormat(option.id);
                    void refreshSize(option.id);
                  }}
                />
                {option.label} <span className="text-[11px] text-[#404040]">({option.hint})</span>
              </label>
            ))}
          </fieldset>
          <span role="status" className="text-[11px] text-[#404040]">
            {sizeBytes === null ? "" : `About ${formatKb(sizeBytes)} saved`}
          </span>
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="font-bold">Title</span>
          <input
            className="w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex items-start gap-1">
          <input type="checkbox" checked={shareable} onChange={(event) => setShareable(event.target.checked)} className="mt-0.5" />
          <span>
            <b>Allow sharing this post.</b> It stays encrypted in your vault. It only leaves this device, readable by
            anyone who gets the link or file, if you share it.
          </span>
        </label>
        {notice && <p role="alert" className="text-[#800000]">{notice}</p>}
        <div className="flex gap-2">
          <Button95 type="submit" disabled={saving}>
            {saving ? "Encrypting…" : "🔒 Encrypt & save"}
          </Button95>
          <Link to="/compose">
            <Button95 disabled={saving}>Cancel</Button95>
          </Link>
        </div>
      </form>
    </Window>
  );
}
