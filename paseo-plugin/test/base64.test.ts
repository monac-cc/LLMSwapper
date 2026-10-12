import assert from "node:assert/strict";
import { test } from "node:test";
import { base64Decode, decodeBase64Text, encodeTextBase64Url, utf8Encode } from "../shared/base64.ts";

const samples = ["", "a", "ab", "abc", "Rotación «automática» ✓", "emoji 🧪 y ñ", "x".repeat(1000), '{"a":"\\u2028"}'];

test("utf8Encode matches Buffer", () => {
  for (const s of samples) assert.deepEqual(utf8Encode(s), [...Buffer.from(s, "utf8")]);
});

test("base64url roundtrip and Buffer compatibility", () => {
  for (const s of samples) {
    const b = encodeTextBase64Url(s);
    assert.match(b, /^[A-Za-z0-9_-]*$/);
    assert.equal(b, Buffer.from(s, "utf8").toString("base64url"));
    assert.equal(Buffer.from(b, "base64").toString("utf8"), s); // what BOOT does on the device
    assert.equal(decodeBase64Text(b), s);
    assert.equal(decodeBase64Text(Buffer.from(s, "utf8").toString("base64")), s); // device emits std base64
  }
});

test("base64Decode rejects junk", () => {
  assert.throws(() => base64Decode("ab$c"));
  assert.throws(() => base64Decode("a"));
});
