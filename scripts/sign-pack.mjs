#!/usr/bin/env node
// Signs a RealBud customer pack with the publisher's Ed25519 private key.
//   node scripts/sign-pack.mjs --key <private.pem> --key-id <id> <pack.json> [--out <signed.json>]
//   node scripts/sign-pack.mjs --key <private.pem> --key-id <id> --public   (prints the entry to pin)
// The key may instead come from REALBUD_PACK_SIGNING_KEY (PEM text). It is read
// into memory only: never written, logged or echoed. Run on the publisher's
// machine, outside customer and Hermes storage. Node 24 or later.
import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { validateCustomerPack } from '../server/customer-packs.ts';
import { publicKeyEntry, signPack, verifyPackSignature } from '../server/pack-signing.ts';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0) return undefined; const value = args[at + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`); args.splice(at, 2); return value; };
try {
  const keyPath = option('--key'), keyId = option('--key-id') ?? process.env.REALBUD_PACK_KEY_ID, out = option('--out');
  const printPublic = args.includes('--public'); if (printPublic) args.splice(args.indexOf('--public'), 1);
  if (!keyId || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(keyId)) throw new Error('Give --key-id: lowercase letters, digits, dots and dashes.');
  const pem = keyPath ? readFileSync(keyPath, 'utf8') : process.env.REALBUD_PACK_SIGNING_KEY;
  if (!pem) throw new Error('Give --key <path> or set REALBUD_PACK_SIGNING_KEY.');
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error('The signing key could not be read as a private key.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 private key.');
  const pin = publicKeyEntry(keyId, key);
  if (printPublic) { console.log(JSON.stringify(pin, null, 2)); process.exit(0); }
  if (args.length !== 1) throw new Error('Give exactly one pack file to sign.');
  if (out && existsSync(out)) throw new Error('Choose a new --out file; existing files are never overwritten.');
  const { signature: _previous, ...pack } = validateCustomerPack(JSON.parse(readFileSync(args[0], 'utf8')));
  // Sign the validated form so the installer's own validation reproduces the signed bytes.
  const signed = signPack(validateCustomerPack(pack), key, keyId);
  verifyPackSignature(validateCustomerPack(signed), [pin]);
  const text = JSON.stringify(signed, null, 2) + '\n';
  if (out) { writeFileSync(out, text, { flag: 'wx' }); console.error(`Signed ${signed.id} revision ${signed.revision} with ${keyId}: ${out}`); }
  else process.stdout.write(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Signing failed.');
  process.exit(1);
}
