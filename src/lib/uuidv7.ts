/**
 * UUIDv7: a time-ordered UUID (RFC 9562).
 *
 * The events outbox wants ids that sort by creation time so a B-tree on
 * the primary key appends at the right edge and "events since X" is a
 * range scan. PG16 has no uuidv7 function and the template forbids
 * CREATE EXTENSION, so the publisher mints the id here.
 *
 * Layout: 48 bits of Unix milliseconds, 4 bits version (7), 12 bits of
 * random, 2 bits variant (10), 62 bits of random. Two ids minted in the
 * same millisecond are not ordered relative to each other; that is fine
 * for an outbox (ordering per key is not a property of this version).
 */

const HEX = "0123456789abcdef";

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian timestamp in bytes 0..5.
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  // Version 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant 10xx in the high bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let out = "";
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}

/** The millisecond timestamp a UUIDv7 was minted at. */
export function uuidv7Time(id: string): number {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}
