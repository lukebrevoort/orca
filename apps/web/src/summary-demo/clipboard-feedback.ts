export type ClipboardResult = "copied" | "expired" | "failed";
export function clipboardFeedback(result: ClipboardResult): string {
  switch (result) {
    case "copied": return "Code copied.";
    case "expired": return "Code expired. Nothing copied.";
    case "failed": return "Could not copy. Reveal the code to copy it manually.";
  }
}
