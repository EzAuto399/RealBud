#!/usr/bin/env bash
# Mac side of the Windows clean-environment QA. Uploads run.ps1 as the VM's
# startup script with a fresh run id and the ref, resets (or starts, or
# creates) the VM, follows serial port 1 until RBQA-DONE and writes a receipt.
#
#   scripts/windows-vm-qa/launch.sh [ref] [steps]
#     ref    branch, tag, full SHA or refs/pull/N/head on github.com/EzAuto399/RealBud
#            (default main; an "origin/" prefix is dropped). The ref runs its own QA
#            scripts, so it needs their Windows ports (this branch, or main once merged).
#     steps  all (default) or a comma list of: smoke,unit,dayone,kevin,chaos
#   env: RBQA_PROJECT RBQA_ZONE RBQA_VM RBQA_BUCKET RBQA_INSTALLER RBQA_TIMEOUT_MIN RBQA_OUT
#
# Fictional data only. Never points at a customer account or a real key.
set -euo pipefail

PROJECT=${RBQA_PROJECT:-hermios-492114}
ZONE=${RBQA_ZONE:-australia-southeast1-b}
VM=${RBQA_VM:-realbud-win-qa}
BUCKET=${RBQA_BUCKET:-realbud-win-qa-$PROJECT}
INSTALLER=${RBQA_INSTALLER:-RealBud-0.1.35-54392dd-setup.exe}
TIMEOUT_MIN=${RBQA_TIMEOUT_MIN:-150}
REF=${1:-main}; REF=${REF#origin/}
STEPS=${2:-all}
[[ $REF =~ ^[A-Za-z0-9._/-]{1,200}$ ]] || { echo "bad ref: $REF" >&2; exit 2; }
[[ $STEPS =~ ^[a-z,]{1,60}$ ]] || { echo "bad steps: $STEPS" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
RUN="rbqa-$(date -u +%Y%m%dT%H%M%SZ)"
OUT=${RBQA_OUT:-$root/outputs/windows-vm-qa-$(date +%Y-%m-%d)}
[[ -e $OUT/receipt.json ]] && { echo "$OUT/receipt.json exists; earlier evidence is never overwritten. Set RBQA_OUT." >&2; exit 2; }
mkdir -p "$OUT"
serial="$OUT/serial-$RUN.log"
gc() { gcloud --project "$PROJECT" "$@"; }

status=$(gc compute instances describe "$VM" --zone "$ZONE" --format='value(status)' 2>/dev/null || true)
meta=(--metadata "^;^rbqa-run=$RUN;rbqa-ref=$REF;rbqa-steps=$STEPS;rbqa-bucket=$BUCKET;rbqa-installer=$INSTALLER"
      --metadata-from-file "windows-startup-script-ps1=$here/run.ps1")
offset=0
if [[ -z $status ]]; then
  echo "creating $VM (12 h max run, then deleted)"
  gc compute instances create "$VM" --zone "$ZONE" --image-family windows-2025 --image-project windows-cloud \
    --machine-type e2-standard-4 --boot-disk-size 80GB --max-run-duration 12h --instance-termination-action DELETE \
    --labels purpose=realbud-windows-qa "${meta[@]}"
else
  gc compute instances add-metadata "$VM" --zone "$ZONE" "${meta[@]}"
  offset=$(gc compute instances get-serial-port-output "$VM" --zone "$ZONE" --start=0 2>&1 >/dev/null | grep -o -- '--start=[0-9]*' | tail -1 | cut -d= -f2 || true)
  offset=${offset:-0}
  if [[ $status == RUNNING ]]; then gc compute instances reset "$VM" --zone "$ZONE"; else gc compute instances start "$VM" --zone "$ZONE"; fi
fi
echo "run $RUN ref $REF steps $STEPS; following serial port 1 (timeout ${TIMEOUT_MIN} min)"

started=$(date +%s)
: > "$serial"
while :; do
  err=$(mktemp)
  gc compute instances get-serial-port-output "$VM" --zone "$ZONE" --start="$offset" 2>"$err" >>"$serial.raw" || true
  next=$(grep -o -- '--start=[0-9]*' "$err" | tail -1 | cut -d= -f2 || true); rm -f "$err"
  # A reset can restart the console buffer; never skip ahead of it.
  if [[ -n $next ]]; then (( next < offset )) && next=0; offset=$next; fi
  # This run's lines only: from RBQA-START <run> to RBQA-DONE <run>.
  seen=$(wc -l < "$serial")
  # The runner's "Finished running startup scripts" without RBQA-DONE means the
  # script died; record it instead of waiting out the timeout.
  awk -v run="$RUN" 'index($0, "RBQA-START " run) {on=1} on && /Finished running startup scripts/ {print "RBQA-ENDED-WITHOUT-DONE"; exit}
    on && /RBQA/ {sub(/.*powershell.exe"\): /, ""); print} index($0, "RBQA-DONE " run) {exit}' "$serial.raw" > "$serial.new"
  tail -n +"$((seen + 1))" "$serial.new" | cut -c1-300
  mv "$serial.new" "$serial"
  grep -qE "RBQA-DONE $RUN|RBQA-ENDED-WITHOUT-DONE" "$serial" && break
  if (( $(date +%s) - started > TIMEOUT_MIN * 60 )); then echo "timed out after ${TIMEOUT_MIN} min without RBQA-DONE" >&2; break; fi
  sleep 20
done
rm -f "$serial.raw"

NODE=$(command -v node || echo "$HOME/.nvm/versions/node/v24.21.0/bin/node")
"$NODE" - "$serial" "$OUT/receipt.json" "$RUN" "$REF" "$STEPS" "$VM" "$PROJECT" "$ZONE" "$INSTALLER" "$started" <<'EOF'
const fs = require("node:fs");
const [serial, receiptPath, run, ref, steps, vm, project, zone, installer, started] = process.argv.slice(2);
const lines = fs.readFileSync(serial, "utf8").split("\n");
const results = [], logs = {}, traps = lines.filter((l) => l.startsWith("RBQA-TRAP "));
for (const line of lines) {
  if (line.startsWith("RBQA-RESULT ")) { try { results.push(JSON.parse(line.slice(12))); } catch { results.push({ step: "unparsed", status: "ERROR", line: line.slice(0, 300) }); } }
  const m = line.match(/^RBQA-LOG (\S+) \| (.*)$/); if (m) (logs[m[1]] ??= []).push(m[2]);
}
const done = lines.some((l) => l === `RBQA-DONE ${run}`);
const fetched = results.find((r) => r.step === "fetch");
const failed = results.filter((r) => !["PASS", "DONE", "SKIP"].includes(r.status)).map((r) => r.step);
const receipt = {
  at: new Date().toISOString(), run, ref, sha: fetched?.sha ?? null, stepsRequested: steps,
  proofLayer: "local tests on a disposable Windows Server 2025 VM (source tree at the ref) plus a silent install of the CI-built, unsigned installer; not installed-device on a customer PC, not live integration, not customer acceptance",
  host: { vm, project, zone, installer, runAs: "SYSTEM (GCE startup script)" },
  completed: done, wallSeconds: Math.round(Date.now() / 1000 - Number(started)), failedSteps: failed,
  results, logs, traps, endedWithoutDone: lines.includes("RBQA-ENDED-WITHOUT-DONE"),
  limits: [
    "Fictional data and loopback fakes only: no customer account, REI, Modelvia key, Gmail or bank was used.",
    "Runs as SYSTEM in session 0: per-user install lands in the SYSTEM profile, no interactive desktop, so window, tray and renderer behaviour are not covered and the session-file ACL check cannot tell SYSTEM apart from the owner.",
    "Node, MinGit and the pnpm store are cached on the VM after its first run; result 'setup' says whether this run started clean.",
    "Windows Server 2025 (10.0.26100) shares the Windows 11 24H2 base but is not a Windows 11 desktop SKU.",
    "The installer comes from the private QA bucket, not from a release channel, and is unsigned unless 'signature' says otherwise.",
  ],
};
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`receipt ${receiptPath}`);
for (const r of results) console.log(`${String(r.status).padEnd(5)} ${r.step}`);
process.exitCode = done && failed.length === 0 ? 0 : 1;
EOF
