// Open a real terminal and run a driver-declared install/sign-in command.
// The command must come from EngineInstall on the server — never from the
// renderer — so Allow cannot become an arbitrary shell.
import { execFile } from "node:child_process";

import type { EngineInstall } from "./contracts.ts";

type Platform = "darwin" | "win32" | "linux";

type Launched = {
  once: (event: "spawn" | "error", listener: () => void) => void;
  unref?: () => void;
};

type Launcher = (executable: string, args: readonly string[], options?: object) => Launched;

export function appleScriptEscape(command: string): string {
  return command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function setupCommandFor(
  install: EngineInstall | undefined,
  snapshot: { state: string; authenticated?: boolean },
  platform: NodeJS.Platform,
): string | null {
  if (!install) return null;
  const signInOnly = snapshot.state === "available" && snapshot.authenticated === false;
  if (signInOnly && install.signInCommand?.trim()) return install.signInCommand.trim();
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return null;
  return install.command?.[platform as Platform]?.trim() || null;
}

export function assertSafeSetupCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 500) {
    throw Object.assign(new Error("invalid setup command"), { status: 400 });
  }
  if (/[\n\r\0]/.test(trimmed)) {
    throw Object.assign(new Error("invalid setup command"), { status: 400 });
  }
  return trimmed;
}

function launch(
  executable: string,
  args: readonly string[],
  options: object | undefined,
  run: Launcher,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = run(executable, args, options);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) child.unref?.();
      resolve(ok);
    };
    child.once("spawn", () => finish(true));
    child.once("error", () => finish(false));
  });
}

export async function openTerminalAndRun(
  command: string,
  platform: NodeJS.Platform = process.platform,
  run: Launcher = execFile as Launcher,
): Promise<boolean> {
  const cmd = assertSafeSetupCommand(command);
  if (platform === "darwin") {
    return launch(
      "osascript",
      ["-e", `tell application "Terminal" to do script "${appleScriptEscape(cmd)}"`],
      undefined,
      run,
    );
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
    ] as const) {
      if (await launch(bin, [...args], undefined, run)) return true;
    }
  }
  return false;
}
