// Pure-TS UTF-8 + base64. The client typecheck has no atob/btoa/TextEncoder, and Hermes support varies.
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE: Record<string, number> = {};
for (let i = 0; i < 64; i++) DECODE[URL_ALPHABET.charAt(i)] = i;
DECODE["+"] = 62;
DECODE["/"] = 63;

export function utf8Encode(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const cont = (b: number | undefined) => b !== undefined && (b & 0xc0) === 0x80;

export function utf8Decode(bytes: readonly number[]): string {
  let out = "";
  const push = (cp: number) => {
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else out += String.fromCharCode(cp);
  };
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) push(b);
    else if (b >= 0xc2 && b < 0xe0 && cont(bytes[i])) push(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b >= 0xe0 && b < 0xf0 && cont(bytes[i]) && cont(bytes[i + 1])) {
      const cp = ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
      push(cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
    } else if (b >= 0xf0 && b < 0xf5 && cont(bytes[i]) && cont(bytes[i + 1]) && cont(bytes[i + 2])) {
      const cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
      push(cp < 0x10000 || cp > 0x10ffff ? 0xfffd : cp);
    } else push(0xfffd);
  }
  return out;
}

/** base64url without padding: only [A-Za-z0-9_-], safe as a bare argv token in cmd, sh and PowerShell. */
export function base64UrlEncode(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += URL_ALPHABET.charAt((n >> 18) & 63) + URL_ALPHABET.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += URL_ALPHABET.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += URL_ALPHABET.charAt(n & 63);
  }
  return out;
}

/** Accepts standard and url alphabets, optional padding. Throws on any other character. */
export function base64Decode(text: string): number[] {
  const s = text.replace(/=+$/, "");
  if (s.length % 4 === 1) throw new Error("base64: longitud inválida");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = DECODE[s.charAt(i)];
    if (v === undefined) throw new Error("base64: carácter inválido");
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

export const encodeTextBase64Url = (text: string): string => base64UrlEncode(utf8Encode(text));
export const decodeBase64Text = (b64: string): string => utf8Decode(base64Decode(b64));
