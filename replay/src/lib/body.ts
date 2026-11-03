/**
 * Read a body stream up to `maxBytes`, never buffering more. `truncated` is true when the stream
 * had more than that; the rest is cancelled unread.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, truncated };
}

export async function readTextCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readCapped(body, maxBytes);
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** Decompress gzip, stopping at `maxBytes` of output (a small body can inflate to gigabytes). */
export async function gunzipCapped(bytes: Uint8Array, maxBytes: number): Promise<{ text: string; truncated: boolean } | { error: string }> {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const r = await readCapped(stream, maxBytes);
    return { text: new TextDecoder().decode(r.bytes), truncated: r.truncated };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
