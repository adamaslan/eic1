export type ShareOutcome = "shared" | "copied" | "downloaded" | "cancelled";

/**
 * Sends a share file the easiest way this browser allows: the native share sheet with the JSON as a
 * file, else the JSON text on the clipboard, else a download.
 */
export async function sharePostFile(filename: string, title: string, text: string): Promise<ShareOutcome> {
  const file = new File([text], filename, { type: "application/json" });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    const { downloadTextFile } = await import("./download");
    downloadTextFile(filename, text);
    return "downloaded";
  }
}
