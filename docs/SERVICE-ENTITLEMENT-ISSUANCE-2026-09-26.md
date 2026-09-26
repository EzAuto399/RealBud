# Desktop service entitlement handoff

The packaged desktop reads `~/.realbud/service-installation.json`,
`service-trust-keys.json` and `service-entitlement.json` at runtime. Linking the
Mac writes the first file. An operator supplies the latter two with a signed
bundle. This handoff does not change the gateway tenant, provision an
installation, grant AI spend, or create a signing key.

## Issue on the gateway operator shell

The Docker image includes `service-entitlement-issuer.ts` and its shared
canonical-signing code. The operator must first place a **private Ed25519 PKCS#8
PEM** at `<protected-key-file>` outside the repository/image, owned by the
operator with mode `0600`. Its parent and the bundle output directory must be
owned by the operator with mode `0700`. Protect and back up that key separately;
loss blocks renewal, and disclosure requires a new key id and rotation.

```sh
node --experimental-strip-types /app/managed-gateway/service-entitlement-issuer.ts \
  --company <gateway-company-id> --installation <linked-host-installation-id> \
  --key-id <unique-public-key-id> --key-file <protected-key-file> \
  --out <private-output-directory>/service-bundle.json
```

The command refuses a missing, suspended or expired office, a missing/revoked
installation, and a foreign or inactive connector device. It takes the licence
and expiry from the gateway tenant, the host from the ready installation and
active device, and the four current service capabilities from fixed product
policy. The grant expires at the earlier of the office expiry and 366 days
after issue. It writes only a signed public envelope and public trust key. Its
one-line receipt contains the output path, public-key SHA-256 digest and expiry;
it never prints the private key. Retain this receipt separately from the bundle
so the Mac installer can check the digest from a second trusted channel.

## Install on the linked Mac

Transfer `service-bundle.json` through an owner-controlled channel into a
private `0600` file. Check the issuer receipt's public-key SHA-256 digest over
that separate channel. Run from a checkout of this release on the Mac; the
installed desktop process already reads the resulting files from its own data
directory and does not need a package rebuild.

```sh
node --experimental-strip-types server/service-entitlement-install-cli.ts \
  --data "$HOME/.realbud" --bundle <private-local-bundle-path> \
  --public-key-sha256 <digest-from-separate-issuer-receipt>
```

The installer requires the existing office-link binding, validates the signed
bytes, expiry and exact company/host match, then writes both files privately
with atomic replacement. It merges a new public key with previously trusted
keys, so a renewal does not interrupt the old grant between writes. A malformed
or mismatched handoff leaves the existing grant in place. Refresh service
status in the desktop and confirm `active` before starting Bud.

To retire a previously trusted signer after a key rotation, rerun the install
command with `--retire-previous-keys`. The new key is trusted, the new grant is
published, and only then are old trust keys removed. Verify `active` afterward.
The ordinary renewal command leaves prior keys trusted until retirement is
explicitly requested.

The installer creates `~/.realbud/.service-entitlement-install.lock` for the
whole handoff. A second installer stops without changing files. A normal exit
removes the lock. If a crash leaves it, inspect its PID and confirm no installer
is running before an operator removes that one lock file and retries. Never
remove the lock merely because it is old; a PID can be reused.

The local signed gate is an offline admission check, not immediate suspension.
Off-device Modelvia and gateway requests still enforce their own live grants;
renew the desktop bundle before its printed expiry.

## First hosted and Mac handoff receipt — 26 September 2026

The issuer and installer shipped in RealBud PR #23, merged as `eb5223bd`.
Fly release v8 ran image `deployment-01M3ER0ABNQB0BDGGYW7GC472A`; the issuer
file was present in that image and the gateway `/ready` endpoint returned HTTP
200. This proves the issuer was deployed and the gateway was responding, not
that a desktop request completed.

For the sole ready installation at this checkpoint, an operator issued one
signed grant using a private signer held on the attached encrypted volume. The
Mac installer checked the public-key digest supplied separately from the
bundle, verified the signature and local installation binding, and installed
the grant locally. No private signer material was transferred to the Mac or
recorded here. The later manual volume snapshot includes the signer, but that
snapshot has not been restored; see
[the Fly recovery receipt](FLY-GATEWAY-RECOVERY-2026-09-26.md).

The RealBud UI then showed **Service access available**. Its Ask screen still
showed **Setup needed**, with **Start this work** disabled, because local
service administration and a workroom were not set up. No in-app question,
Modelvia generation record, or end-to-end billing result was proven by this
grant installation.
