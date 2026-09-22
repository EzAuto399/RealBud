// Outbound installation reporting. No model credentials, work content or remote
// commands cross this boundary; a website link does not grant service access.
import { parseHermesVersion } from "./hermes-pin.js";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { windowsFilePrivacy } from "./windows-file-privacy.js";
/** CLI diagnostics include local paths and update notices; only the product
 * version belongs in the website report. */
export function installationWorkerVersion(diagnostic) {
    return parseHermesVersion(diagnostic ?? "").product ?? null;
}
const ORIGIN = "https://realbud.app";
export function createOfficeLink(options) {
    const directory = join(options.directory, "office-link");
    const path = join(directory, "link.json");
    const fetcher = options.fetch ?? fetch;
    let error;
    let busy = false;
    let timer;
    async function read() {
        let st;
        try {
            st = lstatSync(path);
        }
        catch (e) {
            if (e.code === "ENOENT")
                return null;
            throw e;
        }
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4096 || (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())))
            throw new Error("The saved website link needs private-file recovery.");
        const parent = lstatSync(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== "win32" && ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())))
            throw new Error("The website link needs a private data directory.");
        await windowsFilePrivacy(directory, "directory");
        await windowsFilePrivacy(path, "file");
        let saved;
        try {
            saved = JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            throw new Error("The saved website link needs recovery.");
        }
        if (!saved || saved.version !== 1 || !/^[0-9a-f-]{36}$/i.test(saved.id) || !/^[a-f0-9]{64}$/.test(saved.token) || typeof saved.label !== "string" || saved.label.length > 80 || (saved.code !== undefined && !/^rb1_[a-f0-9]{64}$/.test(saved.code)))
            throw new Error("The saved website link needs recovery.");
        return saved;
    }
    async function save(value) {
        const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
        const dir = lstatSync(directory);
        if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.())))
            throw new Error("The website link needs a private data directory.");
        await windowsFilePrivacy(directory, "directory", !!created);
        writeFileAtomic(path, JSON.stringify(value), 0o600);
        await windowsFilePrivacy(path, "file", true);
    }
    async function status() {
        const saved = await read();
        return saved ? { state: saved.revoked ? "revoked" : saved.companyId ? "linked" : "pending", id: saved.id, label: saved.label, agencyLabel: saved.agencyLabel, lastReportedAt: saved.lastReportedAt, ...(error ? { error } : {}) } : { state: "unlinked" };
    }
    async function request(route, init) {
        try {
            return await fetcher(`${ORIGIN}/api/installations/${route}`, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", ...init.headers } });
        }
        catch {
            throw new Error("The website could not be reached. Your link is saved; try again when connected.");
        }
    }
    async function exclusive(work) {
        if (busy)
            throw Object.assign(new Error("A website link update is already running. Try again shortly."), { status: 409 });
        busy = true;
        try {
            const result = await work();
            error = undefined;
            return result;
        }
        catch (e) {
            error = e instanceof Error ? e.message : "The website link could not be updated.";
            throw e;
        }
        finally {
            busy = false;
        }
    }
    async function link(input) {
        return exclusive(async () => {
            input = input && typeof input === "object" ? input : {};
            const code = typeof input.code === "string" ? input.code.trim() : "";
            const label = typeof input.label === "string" ? input.label.trim() : "";
            if (!/^rb1_[a-f0-9]{64}$/.test(code) || !label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label))
                throw Object.assign(new Error("Paste the link code and name this computer."), { status: 400 });
            let saved = await read();
            if (saved?.companyId && !saved.revoked)
                throw Object.assign(new Error("Disconnect the current website link before linking another office."), { status: 409 });
            if (saved?.code && saved.code !== code && !saved.revoked)
                throw Object.assign(new Error("Retry the original code, or cancel the pending link before using a new code."), { status: 409 });
            // Persist the token before making a request. Repeating this code after a
            // lost response redeems the identical id/token, never a second device.
            if (!saved || saved.revoked || saved.code !== code) {
                saved = { version: 1, id: randomUUID(), token: randomBytes(32).toString("hex"), label, code };
                await save(saved);
            }
            const response = await request("redeem", { method: "POST", body: JSON.stringify({ code, id: saved.id, token: saved.token, label: saved.label, platform: options.platform ?? process.platform, appVersion: options.appVersion }) });
            if (!response.ok)
                throw new Error(response.status === 409 ? "This code is expired or already used. Get a new code from your account owner." : "The website could not finish linking this computer. Try again shortly.");
            const result = await response.json().catch(() => null);
            if (!result || result.installationId !== saved.id || typeof result.companyId !== "string" || !result.companyId || result.companyId.length > 200 || typeof result.agencyLabel !== "string" || result.agencyLabel.length > 200)
                throw new Error("The website returned an incomplete link. Retry the same code.");
            delete saved.code;
            await save({ ...saved, companyId: result.companyId, agencyLabel: result.agencyLabel });
        });
    }
    async function report() {
        if (busy)
            return;
        await exclusive(async () => {
            const saved = await read();
            if (!saved?.companyId || saved.revoked)
                return;
            const report = await options.report();
            const response = await request("report", { method: "POST", headers: { Authorization: `Bearer ${saved.token}` }, body: JSON.stringify(report) });
            if (response.status === 401) {
                await save({ ...saved, revoked: true });
                return;
            }
            if (!response.ok)
                throw new Error("The website did not accept the latest status. Your local work can continue.");
            await save({ ...saved, lastReportedAt: new Date().toISOString() });
        });
    }
    async function disconnect() {
        return exclusive(async () => {
            const saved = await read();
            if (!saved)
                return;
            // Even a pending link might have been redeemed before its response was
            // lost; revoke the saved token before discarding it locally.
            if (!saved.revoked) {
                const response = await request("report", { method: "DELETE", headers: { Authorization: `Bearer ${saved.token}` } });
                if (!response.ok && response.status !== 401)
                    throw new Error("The website link could not be revoked. Try again when connected.");
            }
            unlinkSync(path);
        });
    }
    return { status, link, report, disconnect,
        async credentials() {
            const saved = await read();
            return saved?.companyId && !saved.revoked ? { installationId: saved.id, token: saved.token, companyId: saved.companyId, agencyLabel: saved.agencyLabel ?? "" } : null;
        },
        start() { if (timer)
            return; const tick = () => { void report().catch(() => { }); }; tick(); timer = setInterval(tick, 5 * 60_000); timer.unref(); },
        stop() { if (timer)
            clearInterval(timer); timer = undefined; }, };
}
