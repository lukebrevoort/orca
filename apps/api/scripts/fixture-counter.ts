// Synthetic fixture diagnostics only. Never log URLs, headers, bodies or errors.
export function fixtureCounterResponse(request: Request, token: string, count: number,
  emit: (line: string) => void = console.log): Response {
  const candidate = request.headers.get("X-Orca-Fixture-Trace") ?? "";
  const id = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(candidate) ? candidate : "uncorrelated";
  const status = request.headers.get("Authorization") === `Bearer ${token}` ? 200 : 401;
  emit(`[counter-server] epoch_ms=${Date.now()} id=${id} event=received`);
  const response = status === 200 ? Response.json({ count }) : new Response(null, { status });
  // This proves response construction, not delivery across the socket.
  emit(`[counter-server] epoch_ms=${Date.now()} id=${id} event=response_ready status=${status}`);
  return response;
}
