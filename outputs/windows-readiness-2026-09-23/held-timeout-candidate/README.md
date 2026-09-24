# Rejected Windows timeout candidate

**HOLD — not integrated.** The user requires stopping after three failed fixes. The doubtful assumption was that overriding `execFile` termination preserves Node's pipe/completion semantics while reliably reaping Windows descendants.

The process files were clean before this task. Only this task's edits to `server/procs.ts` and `server/procs.test.ts` were restored, and its new `server/procs-timeout.test.ts` was removed from the active test suite. This directory preserves the rejected patch, tests and intermediate local results. Passing intermediate tests are not evidence for the final application.

Independent review used Node 24.21.0's implementation and disposable Darwin process models, including an injected Windows platform branch. It found:

1. Node's timeout destroys output pipes before calling `child.kill`. A writing launcher can exit on EPIPE before asynchronous Windows tree enumeration; a descendant remains.
2. An accepted asynchronous termination can race with exit 0 and return successful-looking partial output. An interim fix rejected that result but did not solve the complete lifecycle.
3. Replacing Node's timer left a deadline hole: if the leader had already exited while its grandchild held the inherited output pipes, `child.kill` returned false and did not close the pipes. A 100 ms timeout still had no callback at 500 ms; manually closing pipes returned success.

The reviewer cleaned up all controlled processes. These reproductions are not native Windows evidence. A later bounded process-lifecycle design must cover live leader, exited leader, inherited handles, timeout, output overflow, cancellation, permission refusal and cleanup completion together, followed by native Windows tests. Do not apply this patch to produce an installer.
