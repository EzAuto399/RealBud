Read-only focused code review of a new RealBud Hermes MCP memory-proposal capability. No tools, web, source edits, or upstream/provider calls. Review ONLY the newly added memoryProposals/memoryBroker lifecycle and contract, not unrelated ACP. Host callbacks must never serialize. Only driverKind hermesAgent may mount. Runtime warm signature binds immutable opaque host scope. Broker calls must use CURRENT turn callback with exact captured-scope comparison and active promptSent/noncancelled/nonsettled run. Discovery must work before prompt; tools/call must require active scope, including cached replies. Cancel pending on interruption/settlement, close on termination, retain safe same-scope warm reuse. Proposal persists pending human review only. Broker API startMemoryProposalBroker({isActive,propose(input,signal),assertCapability?}) => {descriptor,cancelPending,close}. Broker allows discovery while open, enforces isActive/entitlement for calls/cache, aborts+generation-fences pending on cancel. Types MemoryProposalInput={requestId,payload}, Result={version:1,id,reviewLocation}. Find demonstrable defects only; if none say approved. Give precise fixes if needed.

const acpMcpServers = (turn: SendTurnInput): AcpMcpServer[] => {
        const servers: AcpMcpServer[] = [];
        if (DRIVER_KIND === "hermesAgent" && turn.integrations?.memoryProposals) {
          const capability = turn.integrations.memoryProposals;
          if (typeof capability.scope !== "string" || !capability.scope || capability.scope.length > 4096 || typeof capability.propose !== "function") {
            throw new Error("Bud’s memory proposal scope is unavailable. Start a new request.");
          }
          servers.push({ type: "http", name: "memory-proposals", url: "http://127.0.0.1/realbud-memory-proposals", headers: [] });
        }
        if (turn.integrations?.browser) servers.push({ type: "http", name: "browser", url: "http://127.0.0.1/realbud-browser", headers: [] });
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            type: "http",
            name: "connected-apps",
            // Replaced with the private broker before session/new or load.
            url: composio.gmailReadOnly ? "http://127.0.0.1/realbud-gmail-readonly" : composio.url || "https://backend.composio.dev/v3/mcp",
            headers: composio.gmailReadOnly ? [] : Object.entries(composio.headers ?? { "x-api-key": composio.key })
              .map(([name, value]) => ({ name, value: String(value) })),
          });
        }
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const computer = turn.integrations?.computer;
        if (computer && !turn.integrations?.browser) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer && !turn.integrations?.browser) {
          const local = turn.integrations.localComputer;
          servers.push({ name: "computer", command: local.command, args: local.args, env: acpEnv(local.env ?? {}) });
        }
        if (turn.computer === true && !turn.integrations?.browser && !servers.some((server) => server.name === "computer")) {
          const conn = readCuaConnection();
          if (conn) {
            servers.push({
              name: "computer",
              command: conn.command,
              args: conn.args,
              env: Object.entries(conn.env).map(([name, value]) => ({ name, value })),
            });
          }
        }
        return servers;
      };

      const signatureFor = (cwd: string, args: string[], mcpServers: AcpMcpServer[], composio?: NonNullable<SendTurnInput["integrations"]>["composio"], memoryScope?: string) =>
        createHash("sha256").update(JSON.stringify({ cli: config.cli, cwd, args, mcpServers,
          ...(mcpServers.some(server => server.name === "memory-proposals") ? { memoryScope } : {}),
          ...(composio?.allowedApps ? { allowedApps: composio.allowedApps } : {}),
          ...(composio?.gmailReadOnly ? { gmailReadOnly: composio.gmailReadOnly, appKey: composio.key } : {}),
          ...(mcpServers.some(server => server.name === "connected-apps") ? { appGeneration: connectedAppsBrokerGeneration() } : {}),
        })).digest("hex");

      

const createRuntime = (
        firstTurn: SendTurnInput,
        cwd: string,
        args: string[],
        mcpServers: AcpMcpServer[],
        signature: string,
      ): SessionRuntime => {
        const { threadId } = firstTurn;
        const child = spawnCli(config.cli, args, {
          cwd,
          env: childEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          privateFiles: support.privateWorkspace === true,
        });
        let current: RunningTurn | null = null;
        let nextId = 1;
        let sessionId: string | null = null;
        let closed = false;
        let sessionAnnounced = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let stderr = "";
        let runtime!: SessionRuntime;
        let appBroker: ConnectedAppsBroker | undefined;
        let browserBroker: BrowserBroker | undefined;
        let memoryBroker: Awaited<ReturnType<typeof startMemoryProposalBroker>> | undefined;
        const memoryScope = DRIVER_KIND === "hermesAgent" ? firstTurn.integrations?.memoryProposals?.scope : undefined;
        const currentMemoryIntegration = () => {
          const run = current;
          if (closed || !run || run.settled || run.cancellationRequested || !run.promptSent || !memoryScope) return undefined;
          const integration = run.turn.integrations?.memoryProposals;
          return integration?.scope === memoryScope && typeof integration.propose === "function" ? integration : undefined;
        };
        const rpcPending = new Map<
          number,
          { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }
        >();

        const eventBase = (run: RunningTurn) => base(threadId, run.turnId);
        const send = (message: unknown) => {
          try {
            child.stdin.write(JSON.stringify(message) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: message });
        };
        const request = (method: string, params: unknown, timeoutMs?: number) =>
          new Promise<any>((resolve, reject) => {
            if (closed) return reject(new Error(`${DRIVER_KIND} session is closed`));
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs);
              timer.unref?.();
            }
            rpcPending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
          });

        const removeRuntime = () => {
          browserBroker?.close();
          appBroker?.close();
          memoryBroker?.close();
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          if (warm.get(threadId) === runtime) warm.delete(threadId);
          sessions.delete(runtime);
        };
        const terminate = () => {
          if (closed) return;
          closed = true;
          removeRuntime();
          for (const pending of rpcPending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new Error("ACP session closed"));
          }
          rpcPending.clear();
          killCliTree(child);
        };
        const park = () => {
          if (closed || current) return;
          runtime.lastUsed = Date.now();
          warm.set(threadId, runtime);
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(terminate, WARM_SESSION_IDLE_MS);
          idleTimer.unref?.();
          if (warm.size > MAX_WARM_SESSIONS) {
            const victim = [...warm.values()]
              .filter((candidate) => candidate !== runtime)
              .sort((a, b) => a.lastUsed - b.lastUsed)[0];
            victim?.stop();
          }
        };
        const settle = (run: RunningTurn, ok: boolean, stopReason: string | null, keepWarm: boolean) => {
          if (run.settled) return;
          run.settled = true;
          // A browser capability belongs to one job attempt, never a warm chat.
          if (browserBroker) { browserBroker.close(); keepWarm = false; }
          appBroker?.cancelPending();
          memoryBroker?.cancelPending();
          if (run.interruptTimer) clearTimeout(run.interruptTimer);
          for (const finish of [...run.asks.values()]) finish({ behavior: "cancel" });
          const tracked = active.get(threadId);
          if (tracked?.turnId === run.turnId) active.delete(threadId);
          if (current === run) current = null;
          if (run.text.trim() || run.answerText.trim()) {
            const text = (run.sawTool ? run.answerText || run.text : run.text).trim();
            if (text) emit({ ...eventBase(run), type: "item.completed", itemType: "assistant_text", text });
          }
          emit({ ...eventBase(run), type: "turn.completed", ok, stopReason, cost: null });
          run.resolveDone();
          if (keepWarm && !closed) park();
          else terminate();
        };

        

const ready = (async () => {
          if (memoryScope && mcpServers.some(server => server.name === "memory-proposals")) {
            memoryBroker = await startMemoryProposalBroker({
              isActive: () => Boolean(currentMemoryIntegration()),
              assertCapability: () => managedService.assertCapability("reasoning"),
              propose: async (proposal, signal) => {
                const run = current, integration = currentMemoryIntegration();
                if (!run || !integration || signal.aborted) throw new Error("This memory proposal request stopped. Review saved proposals before trying again.");
                managedService.assertCapability("reasoning");
                const result = await integration.propose(proposal, signal);
                if (signal.aborted || current !== run || currentMemoryIntegration() !== integration) throw new Error("This memory proposal request stopped. Review saved proposals before trying again.");
                managedService.assertCapability("reasoning");
                return result;
              },
            });
            if (closed) { memoryBroker.close(); throw new Error("Bud’s memory proposal session stopped."); }
            mcpServers = mcpServers.map(server => server.name === "memory-proposals" ? memoryBroker!.descriptor : server);
          }
          

const runPrompt = async (run: RunningTurn, first: boolean) => {
          try {
            const readyState = await ready;
            if (run.settled || current !== run || !sessionId) return;
            // Initialization/authentication can outlast a grant. Check the
            // resolved session capabilities at the actual prompt boundary,
            // including a computer mounted through the CUA fallback.
            managedService.assertCapability("reasoning");
            if (mcpServers.some(server => server.name === "computer" || server.name === "browser")) managedService.assertCapability("computer-use");
            if (!sessionAnnounced) {
              sessionAnnounced = true;
              emit({
                ...eventBase(run),
                type: "session.started",
                sessionId,
                model: readyState.init?._meta?.modelState?.currentModelId ?? run.turn.model ?? null,
              });
            }
            run.promptSent = true;
            const promptTurn = first && !readyState.loaded ? replayOnFreshSession(run.turn) : run.turn;
            const text = support.buildPromptText
              ? support.buildPromptText(promptTurn)
              : promptTurn.system
                ? `${promptTurn.system}\n\n${promptTurn.text}`
                : promptTurn.text;
            const result = await request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text }],
            });
            if (run.settled || current !== run) return;
            const usage = result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...eventBase(run),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(run, true, null, true);
            else if (reason === "cancelled") settle(run, true, "cancelled", true);
            else settle(run, false, reason ?? "failed", false);
          } catch (error) {
            if (run.settled || current !== run) return;
            const message = error instanceof Error ? error.message : String(error);
            const needsAuth = message === support.loginNote;
            emit({ ...eventBase(run), type: "runtime.error", message, ...(needsAuth ? { setup: true } : {}) });
            settle(run, false, needsAuth ? "auth_required" : "rpc_error", false);
          }
        };

        const interrupt = async (run: RunningTurn) => {
          if (run.settled) return run.done;
          run.cancellationRequested = true;
          browserBroker?.close();
          appBroker?.cancelPending();
          memoryBroker?.cancelPending();
          for (const finish of [...run.asks.values()]) finish({ behavior: "cancel" });
          if (sessionId && run.promptSent) {
            send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
            if (run.interruptTimer) clearTimeout(run.interruptTimer);
            run.interruptTimer = setTimeout(() => settle(run, true, "cancelled", false), CANCEL_GRACE_MS);
            run.interruptTimer.unref?.();
          } else {
            settle(run, true, "cancelled", false);
          }
          return run.done;
        };

        const resume = (turn: SendTurnInput, first = false) => {
          if (closed) throw new Error(`${DRIVER_KIND} session is closed`);
          if (current) throw new Error("a turn is already running on this thread");
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          if (warm.get(threadId) === runtime) warm.delete(threadId);
          let resolveDone!: () => void;
          const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          const run: RunningTurn = {
            turn,
            turnId: newId(),
            text: "",
            answerText: "",
            sawTool: false,
            promptSent: false,
            settled: false,
            cancellationRequested: false,
            asks: new Map(),
            interruptTimer: null,
            done,
            resolveDone,
          };
          current = run;
          active.set(threadId, {
            turnId: run.turnId,
            asks: run.asks,
            stop: () => settle(run, false, "interrupted", false),
            interrupt: () => interrupt(run),
          });
          emit({ ...eventBase(run), type: "turn.started" });
          void runPrompt(run, first);
          return run.turnId;
        };

        runtime = {
          signature,
          lastUsed: Date.now(),
          resume,
          stop: () => {
            const run = current;
            if (run && !run.settled) settle(run, false, "interrupted", false);
            else terminate();
          },
        };
        sessions.add(runtime);
        return runtime;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        managedService.assertCapability("reasoning");
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const mcpServers = acpMcpServers(turn);
        if (mcpServers.some(server => server.name === "computer" || server.name === "browser")) managedService.assertCapability("computer-use");
        const args = support.spawnArgs(config, turn);
        const signature = signatureFor(cwd, args, mcpServers, turn.integrations?.composio, turn.integrations?.memoryProposals?.scope);
        let runtime = warm.get(threadId);
        // A rewind or poisoned-session recovery deliberately clears the
        // persisted cursor. Do not let the warm-process optimization undo
        // that signal by continuing the abandoned in-memory conversation.
        if (runtime && typeof turn.resumeCursor !== "string" && (turn.transcript?.length ?? 0) > 0) {
          runtime.stop();
          runtime = undefined;
        }
        if (runtime && runtime.signature !== signature) {
          runtime.stop();
          runtime = undefined;
        }
        const first = !runtime;
        runtime ??= createRuntime(turn, cwd, args, mcpServers, signature);
        return { turnId: runtime.resume(turn, first) };
      };

      