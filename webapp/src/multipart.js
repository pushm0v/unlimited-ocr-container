/**
 * Minimal multipart/form-data parser for file uploads.
 *
 * Buffer-based on purpose: splitting on a decoded string would corrupt binary
 * PDF bytes. Unlike the single-file parser in scripts/serve.py this returns
 * every file part, since the whole point of the app is multi-file upload.
 */

const DASH = 0x2d; // '-'
const CR = 0x0d;
const LF = 0x0a;

function indexOfBuffer(haystack, needle, from = 0) {
  return haystack.indexOf(needle, from);
}

export function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('missing multipart boundary');
  const boundary = (match[1] || match[2]).trim();
  const delim = Buffer.from(`--${boundary}`);

  const files = [];
  let pos = indexOfBuffer(body, delim);
  if (pos === -1) throw new Error('malformed multipart body');

  while (pos !== -1) {
    let cursor = pos + delim.length;

    // "--" immediately after the delimiter marks the final boundary.
    if (body[cursor] === DASH && body[cursor + 1] === DASH) break;
    if (body[cursor] === CR && body[cursor + 1] === LF) cursor += 2;

    const headerEnd = indexOfBuffer(body, Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) break;

    const headers = body.subarray(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const next = indexOfBuffer(body, delim, bodyStart);
    if (next === -1) break;

    // The CRLF directly before the next delimiter belongs to the protocol,
    // not the file. Trimming more than those two bytes corrupts payloads that
    // legitimately end in newlines or dashes.
    let end = next;
    if (body[end - 2] === CR && body[end - 1] === LF) end -= 2;

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);

    if (fileMatch && fileMatch[1]) {
      files.push({
        field: nameMatch ? nameMatch[1] : 'file',
        filename: fileMatch[1],
        blob: Buffer.from(body.subarray(bodyStart, end)),
      });
    }
    pos = next;
  }

  return files;
}
