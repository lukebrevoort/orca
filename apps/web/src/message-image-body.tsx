import { useEffect, useRef, useState } from "react";
import { ReaderBody } from "./reader-body";

type Reasons = { ineligible: number; requestLimit: number; stopped: number; byteBudget: number; downloadFailed: number; invalidRaster: number };
type ImageResult = { bodyHtml: string; sourceRevision: string; loaded: number; reasons: Reasons; slots: Array<{index:number;html:string;bytes:number}>; attemptedIndices:number[] };

/** Consent and downloaded image data exist only while this message is visible. */
export function MessageImageBody({ accountId, messageId, revision, available, html, text }: {
  accountId: string; messageId: string; revision?: string; available?: boolean; html: string | null; text: string | null;
}) {
  const [rendered, setRendered] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const active = useRef<AbortController | null>(null);
  const slots = useRef(new Map<number,{html:string;bytes:number}>());
  const seen = useRef(new Set<number>());
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  async function load() {
    if (active.current || !revision) return;
    const controller = new AbortController(); active.current = controller;
    setLoading(true); setStatus("");
    try {
      const response = await fetch(`/v1/messages/${encodeURIComponent(messageId)}/images/v2?${new URLSearchParams({ accountId })}`, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, retained:[...slots.current.keys()], seen:[...seen.current], remainingBytes:8*1024*1024-[...slots.current.values()].reduce((sum,item)=>sum+item.bytes,0) }),
      });
      if (!response.ok) throw new Error("Image request failed");
      const result = await response.json() as ImageResult;
      if (controller.signal.aborted || active.current !== controller || result.sourceRevision !== revision) return;
      for(const index of result.attemptedIndices)seen.current.add(index);
      for(const slot of result.slots)slots.current.set(slot.index,{html:slot.html,bytes:slot.bytes});
      let combined=result.bodyHtml;
      for(const [index,slot] of slots.current)combined=combined.replace(`<span data-orca-retained-slot="${index}"></span>`,slot.html);
      const r = result.reasons;
      const remaining = r.requestLimit + r.stopped + r.byteBudget + r.downloadFailed + r.invalidRaster;
      const room=8*1024*1024-[...slots.current.values()].reduce((sum,item)=>sum+item.bytes,0);
      const canRetry=remaining>0&&room>=2*1024*1024&&seen.current.size<=200&&slots.current.size<=200;
      setRetryable(canRetry);
      if (slots.current.size) setRendered(combined);
      const total=slots.current.size;
      setStatus(`${total} ${total === 1 ? "image" : "images"} loaded.${remaining ? ` ${remaining} remain unloaded.${canRetry ? " Retry remaining images." : " Image limit reached."}` : ""}${r.ineligible ? ` ${r.ineligible} remain blocked for privacy or unsupported content.` : ""}`);
    } catch {
      if (!controller.signal.aborted && active.current === controller) { setRetryable(true); setStatus("Images could not be loaded. You can try again."); }
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  }
  return <>
    {available && revision && (!status || retryable) ? <div className="reader-images-consent">
      <p>Images are blocked. Loading may tell the sender you opened this message.</p>
      <button type="button" disabled={loading} onClick={() => void load()}>{loading ? "Loading images…" : status ? "Retry images" : "Load images"}</button>
    </div> : null}
    {status ? <p role="status">{status}</p> : null}
    <ReaderBody html={rendered ?? html} text={text} />
  </>;
}
