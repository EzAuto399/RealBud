// Open a real terminal and run a driver-declared install/sign-in command.
// The command must come from EngineInstall on the server — never from the
// renderer — so Allow cannot become an arbitrary shell.
import { execFile } from "node:child_process";
export function appleScriptEscape(command) {
    return command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
export function setupCommandFor(install, snapshot, platform) {
    if (!install)
        return null;
    const signInOnly = snapshot.state === "available" && snapshot.authenticated === false;
    if (signInOnly && install.signInCommand?.trim())
        return install.signInCommand.trim();
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux")
        return null;
    return install.command?.[platform]?.trim() || null;
}
export function assertSafeSetupCommand(command) {
    const trimmed = command.trim();
    if (!trimmed || trimmed.length > 500) {
        throw Object.assign(new Error("invalid setup command"), { status: 400 });
    }
    if (/[\n\r\0]/.test(trimmed)) {
        throw Object.assign(new Error("invalid setup command"), { status: 400 });
    }
    return trimmed;
}
function launch(executable, args, options, run) {
    return new Promise((resolve) => {
        let child;
        try {
            child = run(executable, args, options);
        }
        catch {
            resolve(false);
            return;
        }
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            if (ok)
                child.unref?.();
            resolve(ok);
        };
        child.once("spawn", () => finish(true));
        child.once("error", () => finish(false));
    });
}
export async function openTerminalAndRun(command, platform = process.platform, run = execFile) {
    const cmd = assertSafeSetupCommand(command);
    if (platform === "darwin") {
        return launch("osascript", ["-e", `tell application "Terminal" to do script "${appleScriptEscape(cmd)}"`], undefined, run);
    }
    if (platform === "win32") {
        return launch("powershell.exe", ["-NoExit", "-Command", cmd], { windowsHide: false }, run);
    }
    if (platform === "linux") {
        const held = `${cmd}; exec bash`;
        for (const [bin, args] of [
            ["gnome-terminal", ["--", "bash", "-lc", held]],
            ["konsole", ["-e", "bash", "-lc", held]],
            ["xterm", ["-hold", "-e", "bash", "-lc", cmd]],
        ]) {
            if (await launch(bin, [...args], undefined, run))
                return true;
        }
    }
    return false;
}
