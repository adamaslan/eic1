import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useNavigate } from "react-router";
import { AppError, type Bytes } from "@veil/core";
import {
  encodePalettePng,
  PaintHistory,
  PHOTO_CATEGORY,
  saveComposedItem,
  TEXT_SIZES,
  textFont,
  textSizePx,
  type ComposedMedia,
  type TextSizeId,
} from "@veil/features";
import type { Route } from "./+types/draw";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "untitled - Paint — Everybody is Cool" }];
}

// Small on purpose: a 192px canvas (shown chunky at 320px, like old Paint) with a flat palette
// compresses to a few KB, so a drawing usually fits inside a share-one-post link (8000-char cap,
// and the bundle carries the thumbnail too) instead of needing a share file.
const CANVAS_SIZE = 192;
const DISPLAY_SIZE = 320;
const THUMB_SIZE = 128;
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

// The PNG export is palette-indexed (encodePalettePng): the fixed 16-color canvas snaps
// to ~1-2KB for line art instead of ~6.5KB as RGBA, which is what lets a drawing fit a
// share-one-post link. White moves to the last palette slot as the transparency fallback.
const hexToRgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});
const PNG_PALETTE = [...PALETTE.filter((hex) => hex !== "#ffffff"), "#ffffff"].map(hexToRgb);

async function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Bytes> {
  if (mime === "image/png") {
    const context = canvas.getContext("2d");
    if (!context) throw new AppError("This browser could not encode the drawing.");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return encodePalettePng(canvas.width, canvas.height, pixels.data, PNG_PALETTE);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new AppError("This browser could not encode the drawing.");
  return new Uint8Array(await blob.arrayBuffer());
}

const formatKb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

type Tool = "brush" | "text";

export default function Draw() {
  const vault = useSessionStore((state) => state.vault);
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  // Snapshot-based undo/redo (see PaintHistory): one entry per stroke, clear, or placed text.
  const history = useRef(new PaintHistory<ImageData>());
  // While the text tool is armed, this holds the pixels under the live preview so the
  // preview can redraw on every keystroke without becoming part of the undo history.
  const textBase = useRef<ImageData | null>(null);

  const [color, setColor] = useState<string>(PALETTE[0]);
  const [brush, setBrush] = useState<number>(BRUSHES[1]);
  const [tool, setTool] = useState<Tool>("brush");
  const [textValue, setTextValue] = useState("");
  const [textSizeId, setTextSizeId] = useState<TextSizeId>("m");
  const [textAnchor, setTextAnchor] = useState<{ x: number; y: number } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [format, setFormat] = useState<FormatId>("png");
  const [title, setTitle] = useState("");
  const [shareable, setShareable] = useState(false);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sizeRequest = useRef(0);

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

  const context2d = () => canvasRef.current?.getContext("2d") ?? null;

  const snapshotCanvas = (): ImageData | null => {
    const canvas = canvasRef.current;
    const context = context2d();
    if (!canvas || !context) return null;
    return context.getImageData(0, 0, canvas.width, canvas.height);
  };

  const syncHistoryState = () => {
    setCanUndo(history.current.canUndo);
    setCanRedo(history.current.canRedo);
  };

  const refreshSize = async (targetFormat: FormatId = format) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const request = ++sizeRequest.current;
    try {
      const bytes = await encodeCanvas(canvas, mimeFor(targetFormat), targetFormat === "jpeg" ? JPEG_QUALITY : undefined);
      if (request === sizeRequest.current) setSizeBytes(bytes.length);
    } catch {
      if (request === sizeRequest.current) setSizeBytes(null);
    }
  };

  const drawText = (text: string, anchor: { x: number; y: number }) => {
    const context = context2d();
    if (!context) return;
    context.font = textFont(textSizePx(textSizeId));
    context.fillStyle = color;
    context.textBaseline = "top";
    context.fillText(text, anchor.x, anchor.y);
  };

  // Text tool: the preview is always drawn fresh over textBase, so typing, resizing,
  // recoloring, or moving the anchor never accumulates paint and never enters the undo history.
  useEffect(() => {
    if (tool !== "text") return;
    const context = context2d();
    if (!context) return;
    if (!textBase.current) textBase.current = snapshotCanvas();
    if (!textBase.current) return;
    context.putImageData(textBase.current, 0, 0);
    if (textAnchor && textValue.trim() !== "") drawText(textValue.trim(), textAnchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, textAnchor, textValue, textSizeId, color]);

  // Put the un-previewed pixels back. Used before undo/redo/clear and when leaving the tool.
  const discardTextPreview = () => {
    const context = context2d();
    if (context && textBase.current) context.putImageData(textBase.current, 0, 0);
    textBase.current = null;
    setTextAnchor(null);
  };

  const selectTool = (next: Tool) => {
    if (next === tool) return;
    discardTextPreview();
    setTool(next);
  };

  const undo = () => {
    discardTextPreview();
    const current = snapshotCanvas();
    if (!current) return;
    const previous = history.current.undo(current);
    if (!previous) return;
    context2d()?.putImageData(previous, 0, 0);
    syncHistoryState();
    void refreshSize();
  };

  const redo = () => {
    discardTextPreview();
    const current = snapshotCanvas();
    if (!current) return;
    const next = history.current.redo(current);
    if (!next) return;
    context2d()?.putImageData(next, 0, 0);
    syncHistoryState();
    void refreshSize();
  };

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes - not while typing into a field.
  // No dependency array: the listener re-registers every render so it always calls the
  // current undo/redo closures (an empty-deps version froze first-render state, e.g. a
  // stale image format in refreshSize after switching PNG/JPG).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const downloadImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const bytes = await encodeCanvas(canvas, mimeFor(format), format === "jpeg" ? JPEG_QUALITY : undefined);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(format) });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const base = (title.trim() || "drawing").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
      anchor.href = url;
      anchor.download = `${base}.${format === "jpeg" ? "jpg" : "png"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setNotice("This browser could not encode the drawing.");
    }
  };

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (saving) return;
    if (tool === "text") {
      // Clicking sets where the next placed text starts; the preview effect redraws it.
      setTextAnchor(canvasPoint(event));
      return;
    }
    const before = snapshotCanvas();
    if (before) {
      history.current.record(before);
      syncHistoryState();
    }
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

  const placeText = () => {
    const context = context2d();
    const text = textValue.trim();
    if (!context || !textBase.current || !textAnchor || text === "") return;
    // Commit: restore the pre-preview pixels, record them for undo, then paint the text once.
    context.putImageData(textBase.current, 0, 0);
    history.current.record(textBase.current);
    textBase.current = null;
    syncHistoryState();
    drawText(text, textAnchor);
    setTextValue("");
    setTextAnchor(null);
    void refreshSize();
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    discardTextPreview();
    const before = snapshotCanvas();
    if (before) {
      history.current.record(before);
      syncHistoryState();
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    void refreshSize();
  };

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!vault || !canvas || saving) return;
    // An uncommitted text preview is not part of the drawing: restore the base pixels
    // before the snapshot below so saving never bakes in text the user did not place.
    discardTextPreview();
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
      // Snapshot before the first await: encoding yields to the event loop, and the live
      // canvas must not change between the full image and its thumbnail.
      const snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      const snapshotContext = snapshot.getContext("2d");
      if (!snapshotContext) throw new AppError("This browser could not encode the drawing.");
      snapshotContext.drawImage(canvas, 0, 0);
      const bytes = await encodeCanvas(snapshot, mime, quality);
      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = THUMB_SIZE;
      thumbCanvas.height = THUMB_SIZE;
      const thumbContext = thumbCanvas.getContext("2d");
      if (!thumbContext) throw new AppError("This browser could not encode the drawing.");
      thumbContext.fillStyle = "#ffffff";
      thumbContext.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
      thumbContext.drawImage(snapshot, 0, 0, THUMB_SIZE, THUMB_SIZE);
      const thumb = await encodeCanvas(thumbCanvas, mime, quality);
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
            <Button95 pressed={tool === "brush"} onClick={() => selectTool("brush")} disabled={saving}>
              Brush
            </Button95>
            <Button95 pressed={tool === "text"} onClick={() => selectTool("text")} disabled={saving}>
              Text
            </Button95>
            {tool === "brush" &&
              BRUSHES.map((option) => (
                <Button95 key={option} pressed={brush === option} onClick={() => setBrush(option)}>
                  {option}px
                </Button95>
              ))}
            {tool === "text" &&
              TEXT_SIZES.map((option) => (
                <Button95 key={option.id} pressed={textSizeId === option.id} onClick={() => setTextSizeId(option.id)}>
                  {option.px}px
                </Button95>
              ))}
            <Button95 onClick={undo} disabled={saving || !canUndo}>
              Undo
            </Button95>
            <Button95 onClick={redo} disabled={saving || !canRedo}>
              Redo
            </Button95>
            <Button95 onClick={clearCanvas} disabled={saving}>Clear</Button95>
          </div>
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="touch-none bg-white"
            style={{
              // Fit phones: 320px preferred, shrink before the window overflows
              // (toolbar column + window padding reserve ~120px of the viewport).
              width: `min(${DISPLAY_SIZE}px, calc(100vw - 120px))`,
              height: "auto",
              imageRendering: "pixelated",
              cursor: tool === "text" ? "text" : "crosshair",
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
        {tool === "text" && (
          <div className="flex flex-wrap items-center gap-1">
            <input
              aria-label="Text to place"
              className="w-40 bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none"
              placeholder="Type text…"
              value={textValue}
              onChange={(event) => setTextValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  placeText();
                }
              }}
            />
            <Button95 onClick={placeText} disabled={saving || !textAnchor || textValue.trim() === ""}>
              Place text
            </Button95>
            <span className="text-[11px] text-[#404040]">
              Click the canvas to choose where the text starts. It lands in the selected color.
            </span>
          </div>
        )}
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
        <div className="flex flex-wrap gap-2 pb-4">
          <Button95 type="submit" disabled={saving}>
            {saving ? "Encrypting…" : "🔒 Encrypt & save"}
          </Button95>
          <Button95 type="button" disabled={saving} onClick={() => void downloadImage()}>
            Download {format === "jpeg" ? "JPG" : "PNG"}
          </Button95>
          <Button95 disabled={saving} onClick={() => navigate("/compose")}>
            Cancel
          </Button95>
        </div>
      </form>
    </Window>
  );
}
