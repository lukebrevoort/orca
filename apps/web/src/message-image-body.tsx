import { useEffect, useRef, useState } from "react";
import { ReaderBody } from "./reader-body";
import { readImageStream, ImageStreamRevisionError, type ImageSummary, type ImageSlot } from "./image-stream";

type Reasons = { ineligible: number; requestLimit: number; stopped: number; byteBudget: number; downloadFailed: number; invalidRaster: number };
type ImageResult = { bodyHtml: string; sourceRevision: string; loaded: number; reasons: Reasons; slots: Array<{index:number;html:string;bytes:number}>; attemptedIndices:number[] };

/** Consent and downloaded image data exist only while this message is visible. */
export function MessageImageBody({ accountId, messageId, revision, available, html, text, onRefresh }: {
  accountId: string; messageId: string; revision?: string; available?: boolean; html: string | null; text: string | null; onRefresh?: () => void;
}) {
  const [rendered, setRendered] = useState<string | null>(null);
  const [progressSlots,setProgressSlots] = useState<ImageSlot[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const active = useRef<AbortController | null>(null);
  const slots = useRef(new Map<number,{html:string;bytes:number}>());
  const seen = useRef(new Set<number>());
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  function requireRefresh(message: string) {
    slots.current.clear(); seen.current.clear(); setRendered(null); setProgressSlots([]); setRetryable(false);
    setNeedsRefresh(true); setStatus(message);
  }

  async function load() {
    if (active.current || !revision) return;
    const controller = new AbortController(); active.current = controller;
    setLoading(true); setStatus("");
    try {
      const response = await fetch(`/v1/messages/${encodeURIComponent(messageId)}/images/v2?${new URLSearchParams({ accountId })}`, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ revision, retained:[...slots.current.keys()], seen:[...seen.current], remainingBytes:8*1024*1024-[...slots.current.values()].reduce((sum,item)=>sum+item.bytes,0) }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          const envelope = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          if (!controller.signal.aborted && active.current === controller && envelope?.error?.code === "stale_message") {
            requireRefresh("This message changed. Refresh it, then choose whether to load images."); return;
          }
        }
        if (response.status === 413) {
          const envelope = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          if (!controller.signal.aborted && active.current === controller && envelope?.error?.code === "image_source_too_large") {
            requireRefresh("Image loading is unavailable for this message. Refresh it to check."); return;
          }
        }
        if ((response.status === 404 || response.status === 501) && !controller.signal.aborted && active.current === controller) {
          requireRefresh("Image loading is unavailable for this message. Refresh it to check."); return;
        }
        throw new Error("Image request failed");
      }
      const finish=(result:ImageSummary)=>{
        for(const index of result.attemptedIndices)seen.current.add(index);
        const r = result.reasons;
        const remaining = r.requestLimit + r.stopped + r.byteBudget + r.downloadFailed + r.invalidRaster;
        const room=8*1024*1024-[...slots.current.values()].reduce((sum,item)=>sum+item.bytes,0);
        const canRetry=remaining>0&&room>=2*1024*1024&&seen.current.size<=200&&slots.current.size<=200&&[...seen.current].every(index=>index<10000)&&[...slots.current.keys()].every(index=>index<10000);
        setRetryable(canRetry);
        const total=slots.current.size;
        setStatus(`${total} ${total === 1 ? "image" : "images"} loaded.${remaining ? ` ${remaining} remain unloaded.${canRetry ? " Retry remaining images." : " Image limit reached."}` : ""}${r.ineligible ? ` ${r.ineligible} remain blocked for privacy or unsupported content.` : ""}`);
      };
      if(response.headers.get("content-type")?.split(";")[0]?.trim()==="application/x-ndjson"){
        await readImageStream(response,revision,controller.signal,event=>{
          if(controller.signal.aborted||active.current!==controller)throw new Error("Obsolete image stream");
          if(event.type==="start"){
            setRendered(event.bodyHtml);setProgressSlots([...slots.current].map(([index,slot])=>({index,...slot})));
          }else if(event.type==="image"){
            if(slots.current.has(event.slot.index))throw new Error("Duplicate retained image");
            const totalBytes=[...slots.current.values()].reduce((sum,item)=>sum+item.bytes,0)+event.slot.bytes;
            if(totalBytes>8*1024*1024)throw new Error("Image limit reached");
            slots.current.set(event.slot.index,{html:event.slot.html,bytes:event.slot.bytes});
            seen.current.add(event.slot.index);
            setProgressSlots([...slots.current].map(([index,slot])=>({index,...slot})));
            const count=slots.current.size;setStatus(`${count} ${count===1?"image":"images"} loaded. Loading remaining images…`);
          }else finish(event);
        });
      }else{
        // Older v2 servers may return JSON. This is the same guarded route and revision contract.
        const result = await response.json() as ImageResult & ImageSummary;
        if (controller.signal.aborted || active.current !== controller) return;
        if (result.sourceRevision !== revision) { requireRefresh("This message changed. Refresh it, then choose whether to load images."); return; }
        for(const slot of result.slots)slots.current.set(slot.index,{html:slot.html,bytes:slot.bytes});
        let combined=result.bodyHtml;
        for(const [index,slot] of slots.current)combined=combined.replace(`<span data-orca-retained-slot="${index}"></span>`,slot.html);
        setProgressSlots([]);if(slots.current.size)setRendered(combined);finish(result);
      }
    } catch (error) {
      if(error instanceof ImageStreamRevisionError && !controller.signal.aborted && active.current===controller){requireRefresh("This message changed. Refresh it, then choose whether to load images.");return;}
      if (!controller.signal.aborted && active.current === controller) {
        const count=slots.current.size,room=8*1024*1024-[...slots.current.values()].reduce((sum,item)=>sum+item.bytes,0);
        const canRetry=room>=2*1024*1024&&seen.current.size<=200&&slots.current.size<=200&&[...seen.current].every(index=>index<10000)&&[...slots.current.keys()].every(index=>index<10000);
        setRetryable(canRetry);
        setStatus(count ? `${count} ${count===1?"image":"images"} loaded. Image loading was interrupted.${canRetry?" Retry remaining images.":" Image limit reached."}` : "Images could not be loaded. You can try again.");
      }
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  }
  const unavailable = (available === true || (available === undefined && Boolean(html?.includes('class="orca-mail-image-note"')))) && (!revision || available === undefined);
  return <>
    {unavailable ? <div className="reader-images-consent"><p>Image loading is unavailable for this message.</p>{onRefresh ? <button type="button" onClick={onRefresh}>Refresh message</button> : null}</div> : null}
    {!unavailable && needsRefresh && onRefresh ? <div className="reader-images-consent"><button type="button" onClick={onRefresh}>Refresh message</button></div> : null}
    {!unavailable && !needsRefresh && available && revision && (!status || retryable) ? <div className="reader-images-consent">
      <button type="button" disabled={loading} onClick={() => void load()}>{loading ? "Loading images…" : status ? "Retry images" : "Load images"}</button>
    </div> : null}
    {status ? <p role="status">{status}</p> : null}
    <ReaderBody html={rendered ?? html} text={text} imageSlots={progressSlots} />
  </>;
}
