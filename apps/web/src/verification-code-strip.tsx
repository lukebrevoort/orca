import { useState } from "react";
import { detectVerificationCodes } from "@orca/shared";
import { clipboardFeedback } from "./summary-demo/clipboard-feedback";
import "./verification-code-strip.css";

type Props = { messageId: string; subject?: string | null; bodyText?: string | null; snippet?: string | null };
export function VerificationCodeStrip(props: Props) {
  const codes = detectVerificationCodes(props);
  const identity = JSON.stringify([props.messageId, codes]);
  return codes.length ? <CodeStrip key={identity} codes={codes} /> : null;
}
function CodeStrip({ codes }: { codes: { code: string; start: number }[] }) {
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState("");
  async function copy(code: string) {
    try { await navigator.clipboard.writeText(code); setStatus(clipboardFeedback("copied")); }
    catch { setStatus(clipboardFeedback("failed")); }
  }
  return <section className="verification-code-strip" aria-label="Verification code">
    <span>Verification code</span>
    {codes.map(({ code, start }) => <div key={start}>
      <code>{revealed ? code : "•".repeat(code.length)}</code>
      <button type="button" aria-pressed={revealed} onClick={() => setRevealed(value => !value)}>{revealed ? "Hide" : "Reveal"}</button>
      <button type="button" onClick={() => void copy(code)}>Copy</button>
    </div>)}
    <span role="status">{status}</span>
  </section>;
}
