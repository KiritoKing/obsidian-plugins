import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { extensionId, verifyCrx3 } from "./crx3.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
const publicBase64 = publicDer.toString("base64");

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

function fixture(duplicateSigned = false): Buffer {
  const id = createHash("sha256").update(publicDer).digest().subarray(0, 16);
  const signed = field(1, id);
  const zip = Buffer.from("PK\x03\x04synthetic ZIP bytes");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signed.length);
  const signature = sign(
    "sha256",
    Buffer.concat([Buffer.from("CRX3 SignedData\0"), size, signed, zip]),
    pair.privateKey,
  );
  const proof = Buffer.concat([field(1, publicDer), field(2, signature)]);
  const header = Buffer.concat([
    field(2, proof),
    field(10000, signed),
    ...(duplicateSigned ? [field(10000, signed)] : []),
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

describe("CRX3 release verification", () => {
  test("binds the signed archive to the expected public identity", () => {
    const result = verifyCrx3(fixture(), publicBase64);
    expect(result.extensionId).toBe(extensionId(publicDer));
    expect(result.zip.toString()).toContain("synthetic ZIP bytes");
  });
  test("rejects payload tampering and a different signing identity", () => {
    const altered = fixture();
    altered[altered.length - 1] ^= 1;
    expect(() => verifyCrx3(altered, publicBase64)).toThrow("signature");
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey.export({ type: "spki", format: "der" });
    expect(() => verifyCrx3(fixture(), other.toString("base64"))).toThrow(
      "identity",
    );
  });
  test("rejects oversized, truncated, unsupported and ambiguous headers", () => {
    const huge = fixture();
    huge.writeUInt32LE(1024 * 1024, 8);
    expect(() => verifyCrx3(huge, publicBase64)).toThrow("header size");
    expect(() => verifyCrx3(fixture().subarray(0, 40), publicBase64)).toThrow();
    const old = fixture();
    old.writeUInt32LE(2, 4);
    expect(() => verifyCrx3(old, publicBase64)).toThrow("Invalid CRX3");
    expect(() => verifyCrx3(fixture(true), publicBase64)).toThrow("Ambiguous");
  });
});
