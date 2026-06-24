#!/usr/bin/env node
// Self-check for chunk split + base64 round-trip + concat.
// Run: node scripts/check-chunk-assembly.mjs

import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";

const CHUNK_BYTES = 3 * 1024 * 1024;

function splitToBase64Chunks(buffer, chunkBytes) {
  const chunks = [];
  for (let start = 0; start < buffer.length; start += chunkBytes) {
    const slice = buffer.subarray(start, Math.min(start + chunkBytes, buffer.length));
    chunks.push(slice.toString("base64"));
  }
  return chunks;
}

function assembleFromBase64Chunks(chunks) {
  return Buffer.concat(chunks.map((c) => Buffer.from(c, "base64")));
}

function check(label, sizeBytes) {
  const original = randomBytes(sizeBytes);
  const chunks = splitToBase64Chunks(original, CHUNK_BYTES);
  const expectedChunks = Math.max(1, Math.ceil(sizeBytes / CHUNK_BYTES));
  assert.equal(chunks.length, expectedChunks, `${label}: chunk count`);
  const reassembled = assembleFromBase64Chunks(chunks);
  assert.equal(reassembled.length, original.length, `${label}: length`);
  assert.ok(reassembled.equals(original), `${label}: bytes match`);
  console.log(`ok ${label} (${sizeBytes} bytes, ${chunks.length} chunks)`);
}

check("single chunk", 1024);
check("exactly one chunk", CHUNK_BYTES);
check("two chunks, second partial", CHUNK_BYTES + 1);
check("many chunks", CHUNK_BYTES * 7 + 123);
check("size 1", 1);

console.log("\nAll chunk-assembly checks passed.");
