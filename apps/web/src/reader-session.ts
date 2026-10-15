/** Tab-lifetime metadata only: no mail content, browser storage, or API writes. */
export type ReaderSession = {
  open: string[];
  earlier: boolean;
  entry: string | null;
  unreadEntry: string | null;
  top: number;
  anchor: string | null;
  offset: number;
};
export class ReaderSessions {
  private entries = new Map<string, ReaderSession>();
  constructor(private capacity = 30) {}
  get(account: string, thread: string): ReaderSession | null {
    const key = JSON.stringify([account, thread]);
    const value = this.entries.get(key);
    if (!value) return null;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(account: string, thread: string, value: ReaderSession) {
    const key = JSON.stringify([account, thread]);
    this.entries.delete(key);
    // Bound retained per-thread metadata as well as the number of threads.
    this.entries.set(key, { ...value, open: value.open.slice(-1000) });
    while (this.entries.size > Math.max(1, this.capacity)) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); }
}
