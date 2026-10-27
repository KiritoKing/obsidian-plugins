import { Buffer } from "node:buffer";
import { constants, createHash, createPublicKey, verify } from "node:crypto";

const maximumHeaderBytes = 128 * 1024;
const maximumArchiveBytes = 8 * 1024 * 1024;

// Format: Chromium components/crx_file/crx3.proto. Signing algorithm:
// components/crx_file/crx_creator.cc (RSA_PKCS1_SHA256).
function fields(bytes: Buffer): Map<number, Buffer[]> {
  let offset = 0;
  const result = new Map<number, Buffer[]>();
  const varint = (): number => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      if (offset >= bytes.length) throw new Error("Truncated CRX3 header");
      const byte = bytes[offset++];
      value += (byte & 0x7f) * 2 ** (index * 7);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("Oversized CRX3 header integer");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (tag % 8 !== 2 || tag < 8)
      throw new Error("Unsupported CRX3 header field");
    const size = varint();
    if (size > bytes.length - offset)
      throw new Error("Truncated CRX3 header field");
    const number = Math.floor(tag / 8);
    const values = result.get(number) ?? [];
    values.push(bytes.subarray(offset, offset + size));
    result.set(number, values);
    offset += size;
  }
  return result;
}

function exactlyOne(values: Buffer[] | undefined): Buffer {
  if (values?.length !== 1) throw new Error("Ambiguous CRX3 header");
  return values[0];
}

export function extensionId(publicKey: Buffer): string {
  return Array.from(
    createHash("sha256").update(publicKey).digest().subarray(0, 16),
  )
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((digit) => String.fromCharCode(97 + digit))
    .join("");
}

export function verifyCrx3(
  file: Buffer,
  expectedPublicKeyBase64: string,
): { extensionId: string; zip: Buffer } {
  if (
    file.length < 34 ||
    file.length > maximumArchiveBytes ||
    file.toString("ascii", 0, 4) !== "Cr24" ||
    file.readUInt32LE(4) !== 3
  )
    throw new Error("Invalid CRX3 package");
  const size = file.readUInt32LE(8);
  if (size > maximumHeaderBytes || size > file.length - 12)
    throw new Error("Invalid CRX3 header size");
  const header = fields(file.subarray(12, 12 + size));
  const signed = exactlyOne(header.get(10000));
  const signedId = exactlyOne(fields(signed).get(1));
  const publicKey = Buffer.from(expectedPublicKeyBase64, "base64");
  const digest = createHash("sha256").update(publicKey).digest();
  if (!signedId.equals(digest.subarray(0, 16)))
    throw new Error("CRX3 extension identity mismatch");
  const zip = file.subarray(12 + size);
  if (zip.toString("hex", 0, 4) !== "504b0304")
    throw new Error("Invalid CRX3 ZIP payload");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signed.length);
  const signedBytes = Buffer.concat([
    Buffer.from("CRX3 SignedData\0"),
    length,
    signed,
    zip,
  ]);
  const key = createPublicKey({ key: publicKey, type: "spki", format: "der" });
  const valid = (header.get(2) ?? []).some((value) => {
    const proof = fields(value);
    return (
      exactlyOne(proof.get(1)).equals(publicKey) &&
      verify(
        "sha256",
        signedBytes,
        { key, padding: constants.RSA_PKCS1_PADDING },
        exactlyOne(proof.get(2)),
      )
    );
  });
  if (!valid) throw new Error("CRX3 signature verification failed");
  return { extensionId: extensionId(publicKey), zip };
}
