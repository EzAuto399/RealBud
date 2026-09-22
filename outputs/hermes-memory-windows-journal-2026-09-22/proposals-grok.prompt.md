Review these Windows proposal transitions for concrete defects only. No tools/web/subagents, one turn; no edits or reasoning traces. Production hold stays. Host lock serializes cooperative writers. Request-selected IO is scoped/private/bounded, fixed-error; move_new is no-clobber HANDLE rename; write_new exclusive. Review read/write/flush/ensure wrappers use IO; _path_exists treats only exact missing as absent. Signed v1 journal/HMAC binds workspace/profile/runtime/scope/request key+digest/pending digest. Journal/receipt readers return None or verified data or _bad. Both intent/final human receipts prevent restaging. Both-missing prepared intentionally stays held. Published replay rejects any Windows stage and checks exact request/pending. Count uses IO.names; require_stage reads bounded exact digest. POSIX suffixes unchanged. No release claim.

_write_stage Windows prefix
```python
def _write_stage(review: Any, ctx: Any, stage: str, blob: bytes, digest: str) -> None:
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        if len(blob) > review.MAX_BYTES:
            raise review.ReviewError("capacity")
        data = windows.read(stage, limit=review.MAX_BYTES, missing_ok=True)
        if data is not None:
            if review._sha(data) != digest:
                raise review.ReviewError("recovery-required")
            return
        if _count_dir(review, ctx, _proposals_dir(ctx)) + 1 > review.MAX_DIR:
            raise review.ReviewError("capacity")
        # A journal-owned stage is created exclusively. It is never repaired
        # by replacing a colliding file, even when publication was interrupted.
        windows.write_new(stage, blob)
        data = windows.read(stage, limit=review.MAX_BYTES, missing_ok=True)
        if data is None or review._sha(data) != digest:
            raise review.ReviewError("recovery-required")
        return

```


_publish_new
```python
def _publish_new(review: Any, ctx: Any, parsed: Dict[str, Any], rec_key: str, item_id: str, blob: bytes) -> Dict[str, Any]:
    digest = review._sha(blob)
    stage = _stage_path(ctx, rec_key)
    pending = review._pending_path(ctx, item_id)
    _write_stage(review, ctx, stage, blob, digest)
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        windows.move_new(stage, pending, digest)
    else:
        _link_stage(review, ctx, stage, pending, digest)
        _unlink_stage(review, ctx, stage, pending, digest)
    return _commit_published(review, ctx, parsed, rec_key, item_id, digest)

```


_recover_prepared Windows prefix
```python
def _recover_prepared(
    review: Any,
    ctx: Any,
    journal: Dict[str, Any],
    parsed: Dict[str, Any],
    rec_key: str,
    item_id: str,
    blob: bytes,
) -> Dict[str, Any]:
    digest = journal["pendingDigest"]
    if review._sha(blob) != digest:
        raise review.ReviewError("conflict")
    if journal["id"] != item_id or journal["scopeId"] != parsed["scope_id"]:
        raise review.ReviewError("recovery-required")
    if journal["requestKey"] != rec_key or journal["requestDigest"] != parsed["request_digest"]:
        raise review.ReviewError("conflict")
    stage = _stage_path(ctx, rec_key)
    pending = review._pending_path(ctx, item_id)
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        has_stage = review._path_exists(ctx.profile_dir, stage)
        has_pending = review._path_exists(ctx.profile_dir, pending)
        # Windows publication moves one object; two names are never its valid
        # interrupted state. Do not adopt the POSIX two-hardlink recovery path.
        if has_stage and has_pending:
            raise review.ReviewError("conflict")
        if not has_stage and not has_pending:
            raise review.ReviewError("recovery-required")
        if has_stage:
            _require_stage_file(review, ctx, stage, digest)
            _dry_run(review, ctx, parsed["payload"])
            _ensure_native_room(review, ctx, new_item=True)
            windows.move_new(stage, pending, digest)
        else:
            live = windows.read(pending, limit=review.MAX_BYTES, missing_ok=True)
            if live is None or review._sha(live) != digest:
                raise review.ReviewError("recovery-required")
        return _commit_published(review, ctx, parsed, rec_key, item_id, digest)

```


_commit_published
```python
def _commit_published(
    review: Any, ctx: Any, parsed: Dict[str, Any], rec_key: str, item_id: str, digest: str
) -> Dict[str, Any]:
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None and review._path_exists(ctx.profile_dir, _stage_path(ctx, rec_key)):
        raise review.ReviewError("conflict")
    pending = review._pending_path(ctx, item_id)
    live = review._safe_read(ctx.profile_dir, pending)
    if live is None or review._sha(live) != digest:
        raise review.ReviewError("recovery-required")
    # Recovery can arrive after link/unlink but before either directory fsync.
    review._fsync_path(pending, ctx.profile_dir)
    review._fsync_dir(os.path.dirname(pending), ctx.profile_dir)
    rec = _load_journal(review, ctx, _journal_path(ctx, rec_key))
    if rec is None or rec.get("_bad") or rec["id"] != item_id or rec["pendingDigest"] != digest or rec["requestDigest"] != parsed["request_digest"]:
        raise review.ReviewError("recovery-required")
    rec = {**rec, "state": "published"}
    written = _write_journal(review, ctx, _journal_path(ctx, rec_key), rec)
    again = _load_journal(review, ctx, _journal_path(ctx, rec_key))
    final_live = review._safe_read(ctx.profile_dir, pending)
    if (
        again is None
        or again.get("_bad")
        or again["state"] != "published"
        or final_live is None
        or review._sha(final_live) != digest
        or written["id"] != item_id
        or (windows is not None and review._path_exists(ctx.profile_dir, _stage_path(ctx, rec_key)))
    ):
        raise review.ReviewError("recovery-required")
    return _ok(item_id)

```


propose tail; windows=request-selected IO; parsed/key/id/paths bound
```python
    journal = _load_journal(review, ctx, jpath)
    if journal is not None and journal.get("_bad"):
        raise review.ReviewError("recovery-required")
    claim_exists = review._path_exists(profile, claim) if windows is not None else os.path.lexists(claim)
    if claim_exists:
        if journal is not None and journal["requestDigest"] == parsed["request_digest"]:
            raise review.ReviewError("recovery-required")
        raise review.ReviewError("recovery-required")
    if journal is not None:
        if journal["requestDigest"] != parsed["request_digest"] or journal["scopeId"] != scope_id or journal["requestKey"] != rec_key:
            raise review.ReviewError("conflict")
        receipt = review._read_receipt(ctx, item_id)
        if receipt is not None:
            if receipt.get("_bad") or receipt.get("pendingDigest") != journal["pendingDigest"]:
                raise review.ReviewError("recovery-required")
            # A person can review the visible proposal after the helper exits
            # between publication and its final journal. Never recreate it.
            stage = _stage_path(ctx, rec_key)
            stage_exists = review._path_exists(profile, stage) if windows is not None else os.path.lexists(stage)
            if stage_exists:
                raise review.ReviewError("recovery-required")
            live = review._safe_read(ctx.profile_dir, pending, missing_ok=True)
            if live is not None and review._sha(live) != journal["pendingDigest"]:
                raise review.ReviewError("conflict")
            if journal["state"] == "prepared":
                review._fsync_path(review._receipt_path(ctx, item_id), profile)
                review._fsync_dir(ctx.reviews_dir, profile)
                _write_journal(review, ctx, jpath, {**journal, "state": "published"})
            return _ok(item_id)
        if journal["state"] == "published":
            return _success_existing(review, ctx, journal, item_id, parsed["request_digest"])
        created_at = journal["createdAt"] // 1000
        blob = _pending_bytes(item_id, created_at, parsed["payload"])
        return _recover_prepared(review, ctx, journal, parsed, rec_key, item_id, blob)
    receipt = review._read_receipt(ctx, item_id)
    if receipt is not None:
        raise review.ReviewError("recovery-required")
    pending_exists = review._path_exists(profile, pending) if windows is not None else _lstat_opt(review, pending) is not None
    if pending_exists:
        raise review.ReviewError("conflict")
    if windows is not None and review._path_exists(profile, _stage_path(ctx, rec_key)):
        # Without the signed journal, an orphan stage is not retry authority.
        raise review.ReviewError("recovery-required")
    nprop = _count_dir(review, ctx, _proposals_dir(ctx))
    if nprop + 2 > review.MAX_DIR:
        raise review.ReviewError("capacity")
    _ensure_native_room(review, ctx, new_item=True)
    _dry_run(review, ctx, parsed["payload"])
    created_at = int(time.time())
    blob = _pending_bytes(item_id, created_at, parsed["payload"])
    if len(blob) > review.MAX_BYTES:
        raise review.ReviewError("capacity")
    digest = review._sha(blob)
    rec = {
        "version": 1,
        "state": "prepared",
        "id": item_id,
        "workspaceId": ctx.workspace_id,
        "profileId": ctx.profile_id,
        "runtimeId": ctx.runtime_id,
        "scopeId": parsed["scope_id"],
        "requestKey": rec_key,
        "requestDigest": parsed["request_digest"],
        "pendingDigest": digest,
        "createdAt": created_at * 1000,
    }
    _write_journal(review, ctx, jpath, rec)
    return _publish_new(review, ctx, parsed, rec_key, item_id, blob)

```
