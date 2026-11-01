import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useNavigate } from "react-router";
import { AppError, type Bytes } from "@veil/core";
import {
  encodePalettePng,
  PaintHistory,
  PHOTO_CATEGORY,
  saveComposedItem,
  TEXT_SIZES,
  strokeColor,
  textFont,
  textLineHeight,
  textSizePx,
  wrapTextLines,
  type ComposedMedia,
  type PaintTool,
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

// The exact encoding pipeline used when a drawing is saved to the vault. The preview
// panel reuses it so the preview is byte-for-byte what save (and any later share of
// that post) produces. Snapshot before the first await: encoding yields to the event
// loop, and the live canvas must not change between the full image and its thumbnail.
async function encodeDrawingMedia(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<{ bytes: Bytes; thumb: Bytes }> {
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
  return { bytes, thumb };
}

type Tool = PaintTool;

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
  // Paper is the background color the canvas starts in, Clear restores, and the eraser
  // reveals. It defaults to white, so an untouched workflow behaves exactly as before.
  const [paperColor, setPaperColor] = useState<string>("#ffffff");
  const [brush, setBrush] = useState<number>(BRUSHES[1]);
  const [tool, setTool] = useState<Tool>("brush");
  const [textValue, setTextValue] = useState("");
  const [textSizeId, setTextSizeId] = useState<TextSizeId>("m");
  const [textAnchor, setTextAnchor] = useState<{ x: number; y: number } | null>(null);
  // Word-wrap width for placed text, in canvas pixels. Wraps against the live canvas
  // measurement, so preview and placement always agree.
  const [wrapWidth, setWrapWidth] = useState(96);
  // Live warning when the text block would run past the canvas edge. Placed text is
  // clipped by the bitmap, so the user must see that before placing - never silently.
  const [textOverflow, setTextOverflow] = useState(false);
  // Feature-fate switch: hides the new options (paper, wrap, preview, tiny text) and
  // leaves the original brush/eraser/text workflow. Saved drawings are unaffected.
  const [classic, setClassic] = useState(false);
  // Pointer position for the text-tool crosshair guides. The guides are an overlay:
  // they are never painted into the canvas bitmap, so they cannot enter exports,
  // saved posts, or the undo history.
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [format, setFormat] = useState<FormatId>("png");
  const [title, setTitle] = useState("");
  const [shareable, setShareable] = useState(false);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sizeRequest = useRef(0);
  // Exact-bytes preview of what save (and any later share of that post) produces. The
  // URLs point at the real encoded PNG bytes, never the live canvas, so what is shown
  // here is byte-for-byte what lands in the vault. Nothing is shared from this panel.
  const [preview, setPreview] = useState<{ full: string; thumb: string; bytes: number; mime: string } | null>(null);
  // Ref mirror so the unmount cleanup always revokes the current URLs, not the ones
  // captured by a stale closure.
  const previewRef = useRef<{ full: string; thumb: string } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) {
      context.fillStyle = paperColor;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Mount-only: the initial paper is the default white. Later paper changes never
    // repaint existing pixels by themselves - only "Fill background" does, undoably.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const px = textSizePx(textSizeId);
    context.font = textFont(px);
    context.fillStyle = color;
    context.textBaseline = "top";
    // Newlines are honored first, then each paragraph wraps at the chosen width using
    // the real canvas measurement. Long words hard-break so no characters are dropped.
    const lines = wrapTextLines((line) => context.measureText(line).width, text, wrapWidth);
    const lineHeight = textLineHeight(px);
    lines.forEach((line, index) => {
      if (line !== "") context.fillText(line, anchor.x, anchor.y + index * lineHeight);
    });
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
    if (textAnchor && textValue.trim() !== "") {
      drawText(textValue.trim(), textAnchor);
      const px = textSizePx(textSizeId);
      const lines = wrapTextLines((line) => context.measureText(line).width, textValue.trim(), wrapWidth);
      const blockHeight = (lines.length - 1) * textLineHeight(px) + px;
      const maxLineWidth = Math.max(...lines.map((line) => context.measureText(line).width));
      setTextOverflow(
        textAnchor.x + maxLineWidth > CANVAS_SIZE || textAnchor.y + blockHeight > CANVAS_SIZE,
      );
    } else {
      setTextOverflow(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, textAnchor, textValue, textSizeId, color, wrapWidth]);

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
    setCrosshair(null);
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
    if (tool === "text") setCrosshair(canvasPoint(event));
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const point = canvasPoint(event);
    const from = last.current ?? point;
    context.strokeStyle = strokeColor(tool, color, paperColor);
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
    context.fillStyle = paperColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    void refreshSize();
  };

  // Fill the whole canvas with the paper color on demand. One undoable edit, exactly
  // like Clear - the difference is intent: this is a deliberate background repaint.
  const fillBackground = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    discardTextPreview();
    const before = snapshotCanvas();
    if (before) {
      history.current.record(before);
      syncHistoryState();
    }
    context.fillStyle = paperColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    void refreshSize();
  };

  const closePreview = () => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current.full);
      URL.revokeObjectURL(previewRef.current.thumb);
      previewRef.current = null;
    }
    setPreview(null);
  };

  // Build the exact-bytes preview. An uncommitted text preview is not part of the
  // drawing, so it is discarded first - the panel shows the real save output.
  const showPreview = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    discardTextPreview();
    try {
      const mime = mimeFor(format);
      const { bytes, thumb } = await encodeDrawingMedia(canvas, mime, format === "jpeg" ? JPEG_QUALITY : undefined);
      closePreview();
      const next = {
        full: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })),
        thumb: URL.createObjectURL(new Blob([new Uint8Array(thumb)], { type: mime })),
        bytes: bytes.length,
        mime,
      };
      previewRef.current = next;
      setPreview(next);
    } catch {
      setNotice("This browser could not encode the drawing.");
    }
  };

  // Object URLs are released when the panel closes or the route unmounts.
  useEffect(
    () => () => {
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current.full);
        URL.revokeObjectURL(previewRef.current.thumb);
      }
    },
    [],
  );

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
      const { bytes, thumb } = await encodeDrawingMedia(canvas, mime, quality);
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
            <Button95 pressed={tool === "eraser"} onClick={() => selectTool("eraser")} disabled={saving}>
              Eraser
            </Button95>
            <Button95 pressed={tool === "text"} onClick={() => selectTool("text")} disabled={saving}>
              Text
            </Button95>
            {(tool === "brush" || tool === "eraser") &&
              BRUSHES.map((option) => (
                <Button95 key={option} pressed={brush === option} onClick={() => setBrush(option)}>
                  {option}px
                </Button95>
              ))}
            {tool === "text" &&
              TEXT_SIZES.filter((option) => !classic || option.id !== "xs").map((option) => (
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
          <div className="relative self-start">
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            style={{
              // Fit phones: 320px preferred, shrink before the window overflows
              // (toolbar column + window padding reserve ~120px of the viewport).
              width: `min(${DISPLAY_SIZE}px, calc(100vw - 120px))`,
              height: "auto",
              imageRendering: "pixelated",
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
            onPointerLeave={() => setCrosshair(null)}
            className="block touch-none bg-white"
          />
          {tool === "text" && (
            // Aim aid for the text tool: full-span guides follow the pointer, and a
            // fixed cross marks the anchor once clicked. Difference blending keeps the
            // lines visible over any palette color. Overlay only - never painted.
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {crosshair && (
                <>
                  <div
                    data-testid="text-crosshair-v"
                    className="absolute top-0 bottom-0 w-px bg-white mix-blend-difference"
                    style={{ left: `${(crosshair.x / CANVAS_SIZE) * 100}%` }}
                  />
                  <div
                    data-testid="text-crosshair-h"
                    className="absolute left-0 right-0 h-px bg-white mix-blend-difference"
                    style={{ top: `${(crosshair.y / CANVAS_SIZE) * 100}%` }}
                  />
                </>
              )}
              {textAnchor && (
                <div
                  data-testid="text-anchor-cross"
                  className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${(textAnchor.x / CANVAS_SIZE) * 100}%`,
                    top: `${(textAnchor.y / CANVAS_SIZE) * 100}%`,
                  }}
                >
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white mix-blend-difference" />
                  <div className="absolute left-0 right-0 top-1/2 h-px bg-white mix-blend-difference" />
                </div>
              )}
            </div>
          )}
          </div>
        </div>
        {tool === "text" && (
          <div className="flex flex-wrap items-center gap-1">
            <textarea
              aria-label="Text to place"
              rows={2}
              className="w-48 resize-y bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none"
              placeholder="Type text… Enter adds a new line"
              value={textValue}
              onChange={(event) => setTextValue(event.target.value)}
            />
            <label className={classic ? "hidden" : "flex items-center gap-1 text-[11px] text-[#404040]"}>
              Wrap
              <input
                type="range"
                min={32}
                max={192}
                step={8}
                value={wrapWidth}
                aria-label="Text wrap width"
                onChange={(event) => setWrapWidth(Number(event.target.value))}
                className="w-20"
              />
              {wrapWidth}px
            </label>
            <Button95 onClick={placeText} disabled={saving || !textAnchor || textValue.trim() === ""}>
              Place text
            </Button95>
            <span className="text-[11px] text-[#404040]">
              Crosshairs aim where the text starts - click the canvas to set the spot. Newlines and wrapping shape the
              body; it lands in the selected color.
            </span>
            {textOverflow && (
              <p role="status" className="w-full text-[11px] font-bold text-[#800000]">
                Text runs past the canvas edge: move the anchor, change the wrap, or pick a smaller size, or the part
                outside will be cut off.
              </p>
            )}
          </div>
        )}
        <label className="flex items-center gap-1 text-[11px] text-[#404040]">
          <input type="checkbox" checked={classic} onChange={(event) => setClassic(event.target.checked)} />
          Classic tools: hide the new paper, wrap, preview, and tiny-text options
        </label>
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
        <div className={classic ? "hidden" : "flex flex-wrap items-center gap-0.5"}>
          <span className="mr-1 text-[11px] font-bold">Paper</span>
          {PALETTE.map((option) => (
            <button
              key={`paper-${option}`}
              type="button"
              aria-label={`Paper color ${option}`}
              onClick={() => setPaperColor(option)}
              className="h-4 w-4"
              style={{
                background: option,
                borderTop: paperColor === option ? "2px solid #808080" : "1px solid #ffffff",
                borderLeft: paperColor === option ? "2px solid #808080" : "1px solid #ffffff",
                borderRight: paperColor === option ? "2px solid #808080" : "1px solid #808080",
                borderBottom: paperColor === option ? "2px solid #808080" : "1px solid #808080",
              }}
            />
          ))}
          <Button95 onClick={fillBackground} disabled={saving}>
            Fill background
          </Button95>
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
        {preview && (
          <fieldset className="flex flex-col gap-1 border border-[#808080] p-2">
            <legend className="px-1 text-[11px] font-bold">Save preview</legend>
            <p className="text-[11px] text-[#404040]">
              Exactly what saves to your vault - and what someone you share the post with sees. Nothing leaves this
              device from this preview.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <figure className="flex flex-col items-center gap-0.5">
                <img
                  src={preview.full}
                  alt="Full-size preview of the encoded drawing"
                  className="h-24 w-24"
                  style={{
                    imageRendering: "pixelated",
                    borderTop: "2px solid #808080",
                    borderLeft: "2px solid #808080",
                    borderRight: "2px solid #ffffff",
                    borderBottom: "2px solid #ffffff",
                  }}
                />
                <figcaption className="text-[10px] text-[#404040]">full 192px, shown at 96 ({formatKb(preview.bytes)})</figcaption>
              </figure>
              <figure className="flex flex-col items-center gap-0.5">
                <img
                  src={preview.thumb}
                  alt="Thumbnail preview of the encoded drawing"
                  className="h-12 w-12"
                  style={{
                    imageRendering: "pixelated",
                    borderTop: "2px solid #808080",
                    borderLeft: "2px solid #808080",
                    borderRight: "2px solid #ffffff",
                    borderBottom: "2px solid #ffffff",
                  }}
                />
                <figcaption className="text-[10px] text-[#404040]">post card 128px, shown at 48</figcaption>
              </figure>
              <Button95 onClick={closePreview}>Close preview</Button95>
            </div>
          </fieldset>
        )}
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
          {!classic && (
            <Button95 type="button" disabled={saving} onClick={() => void showPreview()}>
              Preview save
            </Button95>
          )}
          <Button95 disabled={saving} onClick={() => navigate("/compose")}>
            Cancel
          </Button95>
        </div>
      </form>
    </Window>
  );
}
