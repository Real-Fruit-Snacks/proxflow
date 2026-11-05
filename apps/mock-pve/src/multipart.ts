/** Tiny multipart/form-data parser for the mock's upload endpoint. */
export type Part = { name: string; filename?: string; data: Buffer };

export function parseMultipart(body: Buffer, contentType: string): Part[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('multipart body without boundary');
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts: Part[] = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // closing boundary
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = body.subarray(start, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const data = body.subarray(headerEnd + 4, next - 2); // strip the CRLF before the boundary
    const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? '';
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    parts.push({ name, filename, data: Buffer.from(data) });
    pos = next;
  }
  return parts;
}
