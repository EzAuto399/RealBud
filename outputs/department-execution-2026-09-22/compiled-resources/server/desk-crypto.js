// AES-256-GCM envelope for Desk and audit artifacts. Binary captures stay
// outside the ledger; this wraps JSON or bytes, then the store fsyncs.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
const ALG = "aes-256-gcm";
export function isEncryptedEnvelope(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return v.v === 1 && v.alg === ALG && typeof v.iv === "string" && typeof v.tag === "string" && typeof v.ct === "string";
}
export function encryptBytes(key, plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { v: 1, alg: ALG, iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}
export function decryptBytes(key, envelope) {
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ct = Buffer.from(envelope.ct, "base64");
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}
export function encryptJson(key, value) {
    return encryptBytes(key, Buffer.from(JSON.stringify(value), "utf8"));
}
export function decryptJson(key, envelope) {
    return JSON.parse(decryptBytes(key, envelope).toString("utf8"));
}
