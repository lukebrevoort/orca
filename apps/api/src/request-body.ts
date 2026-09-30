import type { Context, Env, MiddlewareHandler } from "hono";

// Includes JSON-escape headroom for the 1,000-entry sender-preference contract.
// Draft attachment uploads retain their separate 36 MiB admission ceiling.
export const ordinaryJsonBodyBytes = 2 * 1024 * 1024;

/** Count wire bytes before decoding or parsing; Content-Length is only an early rejection hint. */
export async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    await request.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Admit the full bounded representation before Hono's JSON/form/text parsers run. */
export function bodyLimit<E extends Env = Env>(options: {
  maxSize: number;
  onError?: (c: Context<E>) => Response | Promise<Response>;
}): MiddlewareHandler<E> {
  return async (c, next) => {
    if (!c.req.raw.body) return next();
    const bytes = await readBoundedRequestBody(c.req.raw, options.maxSize);
    if (bytes === null) return options.onError?.(c) ?? c.text("Payload Too Large", 413);
    // Preserve the octets and Content-Type. Request.text() decodes UTF-8 exactly
    // as before; no content-encoding expansion or parsing happens at admission.
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    c.req.raw = new Request(c.req.raw, { headers, body: bytes });
    await next();
  };
}
