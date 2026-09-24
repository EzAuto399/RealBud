Review only this bounded test-harness packet for false-green results, incorrect assertions or missing recovery checks. No tools/web. Return at most 4 actionable findings and coverage limits. Do not review broader production/WinAPI correctness.
Production Windows admission remains disabled. Python-only review._dispatch_ready(ctx, storage=io) exists; public main/_dispatch remain platform-unverified on Windows. All relevant IO routes to selected request-bound storage. Actual unmodified admitted Hermes parser/apply_memory_pending imported in isolated venv children; native _write_file and POSIX mutation fallback forbidden. FakeWindowsIO uses explicit POSIX fictional files, NOT WinAPI. API: profile,error_type,read/names/atomic_write/write_new/move_new/delete_exact/flush_file/verify_directory/ensure_directory/lock. delete_exact returns deletion-requested; caller independently observes absence. move_new returns None. No model/provider/customer data.
Other coverage: propose/list/preview/approve/reject exact replay; crash before/after stage move and publication journal; prepared both missing held; both present equal bytes conflict; changed stage and colliding pending preserved; unsigned orphan stage held; human approval/rejection before proposal journal cannot restage; before/after review intent/memory/final receipt exactly one memory write; changed claim/memory preserved; untrusted fields rejected. Hard faults call os._exit. --runtime and fresh --receipt required; selected helper/native source hashes checked before/after; skips fail. Fake writes fsync fictional POSIX files then log then crash. Fake lock is a logged context, not concurrency proof. Child calls require exact expected exit, empty stderr and no forbidden events. Missing production code is a limit. Remaining methods intentionally omitted.
def move_new(self, source, target, expected_digest):
        source, target = self.path(source), self.path(target)
        self.require_lock()
        proposal = source.suffix == ".stage"
        if proposal:
            self.crash("proposal-move-before")
            if self.mode == "foreign-before-move":
                with target.open("xb") as stream:
                    stream.write(FOREIGN)
            elif self.mode == "changed-stage-before-move":
                source.write_bytes(FOREIGN)
        if digest(self.read(source)) != expected_digest or target.exists():
            raise self.review.ReviewError("conflict")
        ORIGINAL["rename"](source, target)
        self.event("move-new", target)
        if proposal:
            self.crash("proposal-move-after")
        return None

def delete_exact(self, path, expected_digest):
        target = self.path(path)
        self.require_lock()
        if self.mode == "changed-before-delete":
            target.write_bytes(FOREIGN)
        if digest(self.read(target)) != expected_digest:
            raise self.review.ReviewError("conflict")
        self.event("delete-requested", target)
        if self.mode != "delete-pending":
            ORIGINAL["unlink"](target)
            self.event("delete-namespace-absent", target)
        return "deletion-requested"

def child_main(mode: str) -> int:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("realbud_windows_journal_subject", REVIEW)
    assert spec is not None and spec.loader is not None
    review = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = review
    spec.loader.exec_module(review)
    if mode == "public-windows":
        review.POSIX = False
        return review.main()
    request = json.loads(sys.stdin.buffer.read(128 * 1024))
    io = None
    try:
        ctx = review._parse_request(request)
        if mode == "direct-windows":
            review.POSIX = False
            result = review._dispatch(ctx)
        else:
            io = FakeWindowsIO(review, ctx.profile_dir, mode, Path(os.environ["REALBUD_TEST_EVENT_LOG"]))
            original_import = review._import_native
            def import_native(context):
                original_import(context)
                def forbidden_native(*args, **kwargs):
                    io.event("FORBIDDEN:native-memory-write")
                    raise AssertionError("Selected Windows IO escaped to native MemoryStore._write_file")
                context.MemoryStore._write_file = staticmethod(forbidden_native)
            review._import_native = import_native
            def forbidden_posix(*args, **kwargs):
                io.event("FORBIDDEN:posix-mutation")
                raise AssertionError("Selected Windows IO escaped to a POSIX mutation")
            for name in ORIGINAL:
                if name != "scandir":
                    setattr(os, name, forbidden_posix)
            review.POSIX = False
            result = review._dispatch_ready(ctx, storage=io)
            if io.held:
                raise AssertionError("Selected IO locks remained held after dispatch")
            if review._windows_io(ctx.profile_dir) is not None:
                raise AssertionError("Request-bound selected IO leaked outside dispatch")
        review._emit({"ok": True, "result": result})
    except review.ReviewError as error:
        review._emit({"ok": False, "code": error.code})
    finally:
        if io is not None:
            if io.held:
                raise AssertionError("Selected IO locks leaked after successful or failed dispatch")
            if review._windows_io(io.profile) is not None:
                raise AssertionError("Request-bound selected IO leaked after successful or failed dispatch")
    return 0

def test_delete_request_is_not_terminal_cleanup(self):
        item = self.propose()
        request = self.decision(item, self.preview(item))
        self.assertEqual(self.call(request, mode="delete-pending"), {"ok": False, "code": "recovery-required"})
        claim = self.reviews / "claims" / (item + ".json")
        self.assertTrue(claim.exists())
        self.assertEqual(json.loads((self.reviews / (item + ".json")).read_text())["phase"], "final")
        row = self.success(self.call(self.request("list")))["items"][0]
        self.assertEqual(row["state"], "recovery-required")
        self.assertEqual(self.success(self.call(request))["state"], "applied")
        self.assertFalse(claim.exists())
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)

def test_public_json_and_direct_dispatch_cannot_bypass_windows_hold(self):
        for mode in ("public-windows", "direct-windows"):
            self.assertEqual(self.call(mode=mode), {"ok": False, "code": "platform-unverified"})
        for field in ("storage", "windowsIO", "platform", "_dispatch_ready", "allowWindows", "testMode"):
            self.assertEqual(self.call(self.request(**{field: True}), mode="public-windows"),
                             {"ok": False, "code": "platform-unverified"})
        self.assertFalse(self.reviews.exists())
        self.assertEqual(self.memory.read_text(), BEFORE)