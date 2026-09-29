#!/usr/bin/env python3
"""Scoped Modelvia credential cutover, steps 1-2 (owner-run).

1. Get-or-create the RealBud-scoped Modelvia secret in the macOS Keychain
   (service REALBUD_MODELVIA_SCOPED_SECRET). Re-running reuses it.
2. Set MODELVIA_REALBUD_SCOPED_SECRET + MODELVIA_REALBUD_CLIENT_ID on the
   Modelvia Render service, deploy it, wait for `live`, check /ready.
3. Prove the scoped credential: GET /v1/operator/clients with a fresh
   managed-ai-realbud bearer must answer 200 with exactly the RealBud client.
4. STAGE REALBUD_MODELVIA_SCOPED_SECRET on the Fly gateway (no restart).

The secret is never printed, logged or written to disk outside the Keychain.
Uses the Render CLI login (~/.render/cli.yaml) and the fly CLI login.
Next step (separate): deploy the gateway from main and smoke-test it.
"""
import base64, hashlib, hmac, json, os, re, secrets, subprocess, sys, time, urllib.error, urllib.request

KEYCHAIN_SERVICE = "REALBUD_MODELVIA_SCOPED_SECRET"
KEYCHAIN_ACCOUNT = "realbud-ops"
RENDER_SERVICE = "srv-daoq9cn40ujc7388u21g"  # modelvia-gateway-pilot
MODELVIA = "https://api.modelvia.dev"
CLIENT_ID = "realbud"
FLY_APP = "realbud-managed-gateway"


def step(msg):
    print(f"\n== {msg}", flush=True)


def keychain_secret():
    found = subprocess.run(["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True)
    if found.returncode == 0 and len(found.stdout.strip()) >= 32:
        print("Reusing the existing secret from the Keychain.")
        return found.stdout.strip()
    value = secrets.token_urlsafe(48)  # 64 URL-safe characters
    subprocess.run(["security", "add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", value, "-U"],
                   check=True, capture_output=True)
    print("Generated a new 64-character secret and saved it to the Keychain.")
    return value


def render_token():
    cfg = open(os.path.expanduser("~/.render/cli.yaml")).read()
    match = re.search(r"^\s+key:\s*(\S+)", cfg, re.M)
    if not match:
        sys.exit("Render CLI is not logged in. Run `render login` first.")
    return match.group(1)


def http(method, url, token=None, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except Exception:
            return err.code, None


def scoped_bearer(secret):
    now = int(time.time() * 1000)
    claims = {"aud": "managed-ai-realbud", "subject": "realbud-cutover-check", "iat": now, "exp": now + 120_000}
    payload = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{payload}.{sig}"


def main():
    step("1. Scoped secret (Keychain)")
    secret = keychain_secret()

    if "--verify-and-stage" in sys.argv:
        print("Skipping Render changes (--verify-and-stage).")
    else:
        deploy_modelvia(secret)
    verify_and_stage(secret)


def deploy_modelvia(secret):
    step("2. Modelvia on Render: set variables")
    rtok = render_token()
    base = f"https://api.render.com/v1/services/{RENDER_SERVICE}"
    for key, value in (("MODELVIA_REALBUD_SCOPED_SECRET", secret), ("MODELVIA_REALBUD_CLIENT_ID", CLIENT_ID)):
        status, _ = http("PUT", f"{base}/env-vars/{key}", rtok, {"value": value})
        print(f"  {key}: HTTP {status}")
        if status not in (200, 201):
            sys.exit("Stopped: Render refused the variable. Nothing was deployed.")

    step("2b. Modelvia on Render: deploy and wait for live")
    status, deploy = http("POST", f"{base}/deploys", rtok, {"clearCache": "do_not_clear"})
    if status not in (200, 201) or not deploy:
        sys.exit(f"Stopped: deploy request answered HTTP {status}.")
    deploy_id = deploy.get("id")
    print(f"  deploy {deploy_id} started")
    deadline = time.time() + 20 * 60
    state = None
    while time.time() < deadline:
        time.sleep(15)
        _, d = http("GET", f"{base}/deploys/{deploy_id}", rtok)
        state = (d or {}).get("status")
        print(f"  status: {state}", flush=True)
        if state in ("live", "build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"):
            break
    if state != "live":
        sys.exit("Stopped: the Modelvia deploy did not go live. Render keeps the previous instance serving; "
                 "check `render logs` for 'RealBud scoped credential' before retrying.")
    status, ready = http("GET", f"{MODELVIA}/ready")
    print(f"  {MODELVIA}/ready: HTTP {status}")


def verify_and_stage(secret):
    step("3. Prove the scoped credential at Modelvia")
    # Render's edge can answer 502 for a minute while a new instance takes over.
    for attempt in range(6):
        status, body = http("GET", f"{MODELVIA}/v1/operator/clients", scoped_bearer(secret))
        if status not in (502, 503, 504):
            break
        print(f"  HTTP {status} (switchover); retrying in 15 s")
        time.sleep(15)
    # The scoped credential sees only its own client: {accounts:[client]} (platform-admin.ts).
    clients = body.get("accounts") if isinstance(body, dict) else None
    ids = [c.get("id") for c in clients] if isinstance(clients, list) else []
    print(f"  GET /v1/operator/clients: HTTP {status}; client ids visible: {ids}")
    if status != 200 or ids != [CLIENT_ID]:
        sys.exit("Stopped: the scoped credential did not see exactly the RealBud client. Fly was NOT changed.")

    step("4. Stage the secret on the Fly gateway (no restart)")
    staged = subprocess.run(["fly", "secrets", "import", "--stage", "-a", FLY_APP],
                            input=f"REALBUD_MODELVIA_SCOPED_SECRET={secret}\n", text=True, capture_output=True)
    print("  fly secrets import --stage:", "ok" if staged.returncode == 0 else f"FAILED ({staged.stderr.strip()[:200]})")
    if staged.returncode != 0:
        sys.exit(1)

    print("\nDone. Modelvia accepts the scoped credential and the gateway has it staged.\n"
          "Next: deploy the gateway from main, then smoke-test provisioning, then unset the old global secret.")


if __name__ == "__main__":
    main()
