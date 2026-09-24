```json
{
  "decisions": {
    "modules": {
      "extend": [
        "server/private-backup-operations.ts",
        "server/private-backup-transfer.ts",
        "server/private-backup-prepare.ts",
        "server/private-backup-completion.ts (read-only consumer; no receipt rebind)"
      ],
      "use_not_invent": [
        "catalogStorageBudget(limits) from catalog specialist",
        "PrivateBackupPreparedStore physical cap already 3GiB main+rollback / 1GiB bytecap",
        "existing exclusive wx + encrypted envelope + pid/nonce owner + fsyncDir + windowsFilePrivacy"
      ],
      "forbid": [
        "new generic storage/quota framework",
        "ownership from UUID filename",
        "recursive rm of unverified trees",
        "treating damaged/missing marker as empty success",
        "2x blanket physical formula",
        "statfs as OS reservation",
        "plaintext historical receipt as workspace rebind",
        "HTTP exposure of foreign/completed cleanup records",
        "deleting staged|staged|applying|failed+restoreHeld artifacts",
        "releasing reservedBytes before verified unlink of owned bytes",
        "caller-supplied artifact paths"
      ]
    },
    "roots": {
      "journalDir": "BackupOperationStoreOptions.directory (installation-owned)",
      "layout": {
        "operations.sqlite": "existing",
        "transfers/transfers.sqlite": "existing transfer journal",
        "transfers/{uploadId}.ciphertext": "existing; uploadId === operation.id",
        "resources/catalogs/{catalogId}/OWNER": "encrypted marker; catalog files beside it",
        "resources/prepared/{storeId}/OWNER": "encrypted marker; prepared store files beside it",
        "resources/archives/{archiveId}.ciphertext": "export archive bytes",
        "resources/archives/{archiveId}.OWNER": "marker",
        "resources/build/{buildId}/OWNER": "marker; workflow-state.sqlite + DELETE journal only"
      },
      "businessTree": "workspace directory is read/apply target only; never in artifact cleanup"
    },
    "ownership": {
      "truth": "journal allocation row is reservation+owner truth; OWNER marker is on-disk identity; both required to unlink",
      "marker": {
        "create": "wx 0o600, encryptJson(destinationKey), fsync file+dir before any artifact bytes",
        "fields": ["version=1", "resourceId", "kind", "operationId", "workspaceId=operation.workspaceId", "directoryId", "pid", "nonce", "createdAt", "state"],
        "states": ["allocated", "ready", "sealed", "retire-pending"],
        "damaged": "503 preserve; never parse as empty; never unlink"
      },
      "writer": {
        "live": "marker.pid==process.pid && nonce match, or process.kill(pid,0) success → 409, no delete",
        "dead": "ESRCH only; then close this process handles; Windows unlink may still EBUSY/EPERM",
        "quiescence": "persist intent → AbortSignal → await in-process writer (transfer run() tail / prepare assertLease) → close DatabaseSync/file handles → bounded unlink retry → fsyncDir → then journal release"
      }
    },
    "admission": {
      "ledger": "existing operations.reservedBytes sum; cap PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes=32GiB; active=4",
      "journals": "64MiB each via existing max_page_count; charged in statfs projection, not as 2x, not as per-op 2x",
      "peaks_not_2x": {
        "catalog": "catalogStorageBudget(coordinatorLimits).totalBytes (databaseBytes+rollbackBytes+page/spill headers from that function)",
        "prepared": "min(bytecap=1GiB content, physical=3GiB main+rollback+headers); never 2*bytecap",
        "builder": "databaseBytes (optional ≤1GiB, %4096=0, page_size=4096, temp_store=MEMORY so temp=0) + rollbackBytes from same page math as catalog helper or catalogStorageBudget-equivalent for that databaseBytes; SQLITE_FULL typed",
        "archive_or_upload": "declared size, ceiling 1GiB"
      },
      "per_kind_peak": {
        "export": "catalog.totalBytes + 1GiB archive (coexist during sealing)",
        "upload": "archiveBytes + catalog.totalBytes + preparedPhysical3GiB + builderPeak (coexist during staging/prepare)"
      },
      "create_reservedBytes": "that peak; never reduce until owned files unlinked",
      "statfs": "gate only: bavail*bsize >= (sum(reservedBytes)+newPeak+journalCaps - scannedOwnedBytes). Race-ok. Not a reservation. Fail 507 insufficient-space",
      "component_reject": "413/400 if any single component exceeds its ceiling before ledger"
    },
    "visibility": {
      "get_update_list": "unchanged: 404 foreign owners",
      "completed_restore": "keeps operation.workspaceId=previous, restoreHeld=true, references intact, reservedBytes>0 until cleanup",
      "customer_routes": "never list/get allocations, markers, paths, foreign/completed cleanup"
    },
    "v1": {
      "if_operations_sqlite_exists": "refuse v1 restore (restore-unavailable). Journal header identity stays. No receipt-based rebind"
    },
    "transfer_rebind": "only after operations journal accepted exact cold completion (same proof already committed). previousWorkspaceId from proof/operation, never receipt. Rewrite transfer owner.workspaceId to current; leave historical upload.workspaceId; read path accepts current or previousWorkspaceId until those rows pruned"
  },
  "schemaApi": {
    "BackupOperationStoreOptions.limits": "unchanged input; persist sticky copy into control on first successful open if absent; later opens must match stored limits or 503",
    "control_payload": {
      "was": ["version", "workspaceId", "owner", "initialization"],
      "now": ["version", "workspaceId", "owner", "initialization", "limits:{records,active,reservationBytes}"],
      "optional_until_written": "missing limits on existing unreleased DBs: write current validated limits once under owner tx"
    },
    "BackupResourceAllocation": {
      "required": ["directoryId", "resourceId", "kind", "workspaceId", "state"],
      "kind": ["catalog", "prepared", "archive", "build", "upload"],
      "state": ["allocated", "ready", "sealed", "retired"],
      "ids": "privateBackupTransferId; workspaceId === operation.workspaceId"
    },
    "BackupOperationRecord": {
      "keep": ["version:1", "revision", "operation", "reservedBytes", "restoreHeld", "references"],
      "add": "allocations?: { capture?: BackupResourceAllocation, preview?: BackupResourceAllocation, prepared?: BackupResourceAllocation, archive?: BackupResourceAllocation, build?: BackupResourceAllocation, upload?: BackupResourceAllocation }",
      "validate_additions": [
        "exact optional keys only",
        "export: no preview/prepared/build/upload allocations; no restoreHeld",
        "upload: no capture allocation",
        "allocation.resourceId matches later sealed references.catalogId/storeId",
        "completed upload still requires restoreHeld && references.prepared",
        "completed+restoreHeld+reservedBytes=0 allowed (cleanup done)",
        "restoreHeld && phase!=completed && reservedBytes==0 still fail",
        "retired allocations may remain for audit"
      ]
    },
    "create()": "unchanged idempotency; reservedBytes must equal computed peak; phase capturing|uploading",
    "update()": [
      "still 404 foreign",
      "may add allocations and advance allocation state",
      "must not drop restoreHeld, sealed references, or restore preview/prepared identities",
      "reservedBytes decrease only when phase==completed or !restoreHeld, and never below 0, never above before",
      "existing restoreHeld reservedBytes lock for non-completed remains"
    ],
    "new_store_methods": {
      "cleanupScan()": "owner tx read-only: records where reservedBytes>0 AND (phase==completed OR (operation.workspaceId!=current && !restoreHeld) OR phase in cancelled|expired). Never returns staged|applying|restoreHeld-non-completed. Not HTTP",
      "release(id, revision, expect)": "internal; allowed if record in cleanupScan set; requires expect.allocations resourceIds+kinds; after bytes gone sets those states retired and reservedBytes=0; restoreHeld stays true on completed; 409 revision mismatch; 404 never for foreign-in-set (use 409 if not eligible). Does not DELETE row",
      "prune(beforeTime)": "extend: also DELETE completed with restoreHeld && reservedBytes==0 && updatedAt<beforeTime; keep existing cancelled|expired && !restoreHeld && reservedBytes==0. Never prune restoreHeld && reservedBytes>0"
    },
    "createBackupTransferStore": {
      "add_option": "previousWorkspaceId?: string",
      "open": "if owner.workspaceId==workspaceId OK; else if previousWorkspaceId && owner.workspaceId==previousWorkspaceId, rewrite owner.workspaceId=current; else 503. previousWorkspaceId only passed by coordinator after operations cold path committed",
      "validUpload": "workspaceId==current OR workspaceId==previousWorkspaceId",
      "start(id,size)": "id must be operation.id already in operations journal (coordinator enforces before call)"
    },
    "preparePrivateBackupRestore": {
      "remove": "randomUUID scratch under workspace/private-backup-v2/build + rm(recursive,force)",
      "add": "scratchDirectory: preallocated resources/build/{buildId} with OWNER already allocated; databaseBytes unchanged",
      "finally": "do not recursive-rm; return; coordinator cleanup protocol deletes known names only"
    },
    "public_v2_stages": {
      "bind": "every unwired HTTP stage takes operation.id and revision; coordinator update() before/after side effects",
      "map": {
        "POST export": "create(export, peak) → allocate capture catalog marker → capture",
        "POST upload": "create(upload, peak) → allocate upload marker → transfer.start(operation.id,size)",
        "PATCH chunks/seal/check/review/stage/apply/cancel": "load operation, phase gate, same id"
      },
      "no_path_in_public_body": true
    },
    "v1_restore_preflight": "lstat operations.sqlite in v2 journal dir; if file exists refuse v1 apply before workspace.json replace"
  },
  "protocols": {
    "admission": [
      "1. parse kind + declared archiveBytes + coordinator catalog limits + optional builder databaseBytes",
      "2. catalogBudget=catalogStorageBudget(limits); reject if databaseBytes>1GiB or entries>100k coordinator caps",
      "3. builderBytes=databaseBytes??1GiB; reject unless 65536..1GiB and %4096==0",
      "4. peak = kind==export ? catalogBudget.totalBytes+1GiB : archiveBytes+catalogBudget.totalBytes+3GiB+builderBytes+builderRollback",
      "5. reject peak>32GiB or any component ceiling",
      "6. tx: assertOwner; idempotent create; active<4; reservedBytes+peak<=32GiB",
      "7. statfs gate using (ledger+peak+64MiB+64MiB - bounded owned scan); 507 if not",
      "8. commit create() with reservedBytes=peak (durable ownership before bytes)",
      "9. allocate needed markers wx+encrypt+fsync (capture|upload first); on EEXIST reconcile marker to journal allocation else 503",
      "10. exclusive-create artifact (transfer reconcile wx empty; catalog/prepared/build wx)",
      "11. update allocation state ready; later sealed references only after catalog/prepared/archive seal"
    ],
    "retry_lost_response": [
      "create(same id,kind,size) returns existing record; mismatch 409",
      "allocate marker: if marker exists, decrypt, match operationId+kind+workspaceId+resourceId else 503; do not truncate",
      "transfer.start/append/seal existing receipts unchanged",
      "update revision 409 → GET operation → continue from saved phase",
      "never recreate empty file when offset/allocation implies bytes should exist (transfer already fails missing partial)"
    ],
    "cancel": [
      "reject if restoreHeld or phase in staging|staged|applying|completed",
      "1. update(): phase=cancelled, canCancel=false, error optional; COMMIT (public intent durable)",
      "2. abort in-process writer (signal); await queue/lease; close sqlite/handles",
      "3. if marker.pid live other process: stop 409; reservation remains",
      "4. unlink owned artifacts by marker+allocation (not UUID guess); retry Windows EBUSY/EPERM N times after close; ENOENT ok",
      "5. bounded delete known build files: OWNER, workflow-state.sqlite, -journal, -wal, -shm; rmdir if empty; abort if extra entries or symlink",
      "6. fsync parents",
      "7. update/release: allocations retired, reservedBytes=0",
      "8. prune later by time; transfer.cancel already save-then-unlink — call only after operation cancel committed; transfer staged remains forbidden"
    ],
    "restart": [
      "operations open: existing pid steal on ESRCH; sticky limits; cold completion path unchanged (keep previous operation owner + reservedBytes; consume proof only after commit)",
      "current-workspace capturing|sealing|checking → interrupted (existing)",
      "foreign + restoreHeld staging|staged|applying|failed: do not interrupt, do not delete",
      "reconcile allocations: marker+journal; live pid 409; dead → transfer-like size/digest checks; incomplete create stays allocated not empty-ready",
      "nlink/init recovery unchanged",
      "transfer open after cold rebind uses previousWorkspaceId from committed proof only",
      "reservations and component limits carried via control.limits + each record.reservedBytes; do not recompute smaller"
    ],
    "cold_complete": [
      "existing tx: verify proof, maybe phase→completed, header.workspaceId=new, keep operation.workspaceId=previous, restoreHeld, references, reservedBytes>0",
      "commit journal THEN consume() (existing fault completion-committed)",
      "replay: matching completed row + proof → consume only; still no reservation release",
      "then cleanupScan includes that completed row; cleanup uses transfer previousWorkspaceId=proof.previousWorkspaceId",
      "get/list new workspace 404 that id (no history leak on customer routes)"
    ],
    "retention_cleanup": [
      "order always: writer quiescence → unlink owned bytes → fsync → release reservedBytes=0 (references remain) → prune metadata after beforeTime",
      "eligible: completed (any workspace) with verified cold already in journal; OR workspaceId!=current && !restoreHeld; OR cancelled|expired && !restoreHeld",
      "ineligible forever until phase leaves: restoreHeld && phase in staging|staged|applying|failed (uncertain)",
      "scan: opendir fixed parents only, cap entries by records limit+active+32; skip names not UUID; require decryptable OWNER; damaged 503 stop deletes",
      "orphan marker with unknown operationId: delete only if kind in archive|build|upload|export-catalog AND pid dead AND state!=sealed-prepared/preview-restore; else 503",
      "prune(beforeTime): cancelled/expired unused + completed reservedBytes=0; never staged restore evidence",
      "ordinary business files: not under resources/ or transfers/; never listed"
    ]
  },
  "pseudocode": {
    "peak": "function reservationPeak(kind, archiveBytes, catalogLimits, databaseBytes) { const c = catalogStorageBudget(catalogLimits); const build = kind==='upload' ? builderPhysical(databaseBytes??1GiB) : 0; const prepared = kind==='upload' ? PREPARED_PHYSICAL : 0; const arch = min(archiveBytes??1GiB, 1GiB); if (c.databaseBytes>1GiB) fail(413); return kind==='export' ? c.totalBytes+1GiB : arch+c.totalBytes+prepared+build; }",
    "allocate": "update(id,rev, r => { r.allocations[slot] = {directoryId, resourceId: randomUUID(), kind, workspaceId: r.operation.workspaceId, state:'allocated'}; }); writeOwnerMarker(wx); fsync; mkdir/open wx artifact; update state 'ready'",
    "unlinkOwned": "assert marker decrypt matches allocation; assert !symlink && nlink==1; if kill(pid,0) ok && pid!=self fail(409); closeHandles(); for name in knownNames unlink; if dir && count(extra)>0 fail(503); rmdir; fsyncDir; never rm(-r) on parent or unverified path",
    "release": "tx { rec=readAny(id); if !eligible(rec) fail(409); if rec.revision!=rev fail(409); rec.reservedBytes=0; each allocation state='retired'; rec.revision++; save }"
  },
  "topFailureTests": [
    "kill after create() before marker: restart has reservedBytes, no UUID delete, retry allocate wx",
    "kill after marker before bytes: missing artifact is 503 or recreate only if allocation.state=allocated AND size/offset prove empty (upload offset=0 pending=null only); never treat damaged marker as empty",
    "corrupt OWNER bytes: 503 all preserved",
    "cancel committed, kill before unlink: restart cleanupScan unlinks; reservedBytes stays until unlink ok",
    "live marker.pid: cancel/cleanup 409; no unlink; reservation held",
    "Windows unlink EBUSY after close: retry; if still busy do not release()",
    "completed cold: header new, get(id)=404, reservedBytes>0, restoreHeld; cleanup deletes prepared+preview+upload+build only; then reservedBytes=0; prune removes row after beforeTime; customer list never showed it",
    "kill after journal complete before consume: next open completes/consumes; still reservedBytes>0",
    "staging|staged|applying|failed restoreHeld foreign: cleanupScan omits; unlink attempts fail closed",
    "interrupted prepare scratch: only resources/build/{buildId} with valid OWNER deleted file-by-file; parent build/ remains; no recursive force on workspace/private-backup-v2/build",
    "5th active 409; ledger+peak>32GiB 507; archive>1GiB 400; builder databaseBytes not page-aligned 400; catalog over coordinator 1GiB/100k 413",
    "statfs fail 507 then retry succeeds; disk fill during builder SQLITE_FULL 413; prepared not sealed; scratch remains owned until cancel/cleanup; reservation not dropped",
    "lost create/start same id returns same record; different size 409",
    "v1 restore with operations.sqlite present: refused; control.workspaceId unchanged; no receipt rebind test may pass",
    "transfer open with previousWorkspaceId but operations header not rebound / no matching completed proof: coordinator must not pass the option; store still 503 on workspace mismatch",
    "release() then failed prune: metadata remains without bytes; retry prune; never recreate empty history as new op",
    "orphan UUID file without OWNER: skip/do not delete",
    "prepare random scratch regression: source must not mkdir(randomUUID) under workspace"
  ],
  "remainingConstraints": [
    "PRAGMA max_page_count and source ceilings are process-level, not NTFS quota/Windows certification",
    "statfs is racy vs other writers; ledger is the RealBud reservation",
    "Windows may keep file mapped after close; bounded retry then 503 recovery-required, files preserved",
    "catalogStorageBudget math owned by catalog specialist; coordinator must not substitute 2*databaseBytes",
    "public HTTP v2 still unwired; this packet only binds coordinator stages to operation.id/revision",
    "no production v2 artifacts exist; v1 archives remain valid inputs; v1+v2 coexistence = refuse v1 if journal exists",
    "four-active ignores completed (closed phase) but 32GiB still includes completed reservedBytes until release",
    "transfer journal historical rows keep old workspaceId; only owner header rebinds",
    "cleanupScan/release are process-owner APIs, not customer HTTP",
    "builder still reads business files in place; only coordinator resource tree is temporary",
    "exact cold proof remains the only header rebind; this design does not add another"
  ]
}
```