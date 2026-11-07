/** Preserve the pre-streaming process ceiling: at most four image tasks, including
 * queued network/validation work from legacy and JSON callers. */
import { ImageFetchError } from "./remote.ts";
const maximum = 4;
let active = 0;
const waiting: Array<{ signal: AbortSignal; grant: () => void; abort: () => void }> = [];
export async function withImagePermit<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new ImageFetchError("cancelled");
  await new Promise<void>((resolve, reject) => {
    const entry = {
      signal,
      grant() { signal.removeEventListener("abort", entry.abort); active++; resolve(); },
      abort() {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new ImageFetchError("cancelled"));
      },
    };
    if (active < maximum) entry.grant();
    else { waiting.push(entry); signal.addEventListener("abort", entry.abort, { once: true }); if (signal.aborted) entry.abort(); }
  });
  try {
    if (signal.aborted) throw new ImageFetchError("cancelled");
    return await work();
  } finally {
    active--;
    while (waiting.length && active < maximum) {
      const entry = waiting.shift()!;
      if (entry.signal.aborted) { entry.signal.removeEventListener("abort", entry.abort); entry.abort(); }
      else entry.grant();
    }
  }
}
