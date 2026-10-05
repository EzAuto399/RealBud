import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { classifyWorkroomCommand, PINNED_SCRIPTS } from "./workroom-command-policy.ts";

const root = mkdtempSync(join(tmpdir(), "realbud-workroom-policy-"));
const workroom = join(root, "data", "vault");
const runtimeHome = join(root, "runtime");
const venvBin = join(runtimeHome, "hermes-agent", "venv", "bin");
const scripts = join(runtimeHome, "hermes-agent", "skills", "productivity");
const python = join(venvBin, "python3");
const commit = "fictional-runtime-commit";
mkdirSync(workroom, { recursive: true });
mkdirSync(venvBin, { recursive: true });
writeFileSync(python, "");
writeFileSync(join(venvBin, "python"), "");
for (const skill of ["xlsx", "docx", "pdf", "powerpoint"]) mkdirSync(join(scripts, skill, "scripts"), { recursive: true });
writeFileSync(join(scripts, "xlsx", "scripts", "xlsx_create.py"), "# fictional create\n");
writeFileSync(join(scripts, "xlsx", "scripts", "xlsx_recalc.py"), "# fictional recalc\n");
writeFileSync(join(scripts, "docx", "scripts", "docx_edit.py"), "# fictional edit\n");
writeFileSync(join(scripts, "docx", "scripts", "docx_common.py"), "# fictional common\n");
writeFileSync(join(scripts, "pdf", "scripts", "extract_marker.py"), "# fictional marker\n");
writeFileSync(join(scripts, "powerpoint", "scripts", "pptx_render.py"), "# fictional render\n");
const pin = (skill: string) => Object.fromEntries(readdirSync(join(scripts, skill, "scripts")).map((file) =>
  [file, createHash("sha256").update(readFileSync(join(scripts, skill, "scripts", file))).digest("hex")]));
PINNED_SCRIPTS[commit] = { xlsx: pin("xlsx"), docx: pin("docx"), pdf: pin("pdf"), powerpoint: pin("powerpoint") };
mkdirSync(join(root, "elsewhere"));
writeFileSync(join(root, "elsewhere", "other.py"), "");
writeFileSync(join(workroom, "notes.txt"), "fictional");
mkdirSync(join(workroom, "bud-work"));
writeFileSync(join(workroom, "a.docx"), "");
writeFileSync(join(workroom, "spec.json"), "{}");
symlinkSync(join(root, "elsewhere"), join(workroom, "escape"));
afterAll(() => {
  delete PINNED_SCRIPTS[commit];
  rmSync(root, { recursive: true, force: true });
});

const create = join(scripts, "xlsx", "scripts", "xlsx_create.py");
const edit = join(scripts, "docx", "scripts", "docx_edit.py");
const run = `${python} -E -s`;
// Outputs live under bud-work, the only part of the workroom the sandbox lets a script write.
const out = join(workroom, "bud-work", "report.xlsx");
const spec = join(workroom, "spec.json");
// The policy fails closed on a Windows host (backslash paths, cmd/PowerShell
// quoting): every shape that auto-runs on POSIX must still ask there.
const auto = sep === "/" ? "auto" : "ask";
const classify = (command: string, runtimeCommit: string | null = commit) =>
  classifyWorkroomCommand({ command, workroom, runtimeHome, runtimeCommit, platform: "darwin" });

describe("classifyWorkroomCommand", () => {
  it("runs a reviewed document script with workroom paths only", () => {
    expect(classify(`${run} ${create} ${spec} ${out}`)).toBe(auto);
    expect(classify(`${run} '${create}' ${spec} --output=${join(workroom, "bud-work", "out", "report.xlsx")}`)).toBe(auto);
    expect(classify(`${join(venvBin, "python")} -E -s ${edit} ${join(workroom, "a.docx")} -o ${join(workroom, "bud-work", "b.docx")}`)).toBe(auto);
  });
  it("accepts only the absolute venv python with -E -s right before the script", () => {
    expect(classify(`python3 -E -s ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`python -E -s ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`${python} ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`${python} -E ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`${python} -s -E ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`${python} -I ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`${python} -E -s -B ${create} ${spec} ${out}`)).toBe("ask");
  });
  it("asks for scripts outside the allowlist", () => {
    expect(classify(`${run} ${join(root, "elsewhere", "other.py")}`)).toBe("ask");
    expect(classify(`${run} ${join(scripts, "pdf", "scripts", "extract_marker.py")} ${join(workroom, "a.pdf")}`)).toBe("ask");
    expect(classify(`${run} ${join(scripts, "xlsx", "scripts", "xlsx_recalc.py")} ${out}`)).toBe("ask");
    expect(classify(`${run} ${join(scripts, "powerpoint", "scripts", "pptx_render.py")} ${join(workroom, "a.pptx")}`)).toBe("ask");
    expect(classify(`${run} ${join(scripts, "docx", "scripts", "docx_common.py")}`)).toBe("ask");
    expect(classify(`${python} -c print`)).toBe("ask");
  });
  it("asks on an unknown or missing runtime commit", () => {
    expect(classify(`${run} ${create} ${spec} ${out}`, "0000000000000000000000000000000000000000")).toBe("ask");
    expect(classify(`${run} ${create} ${spec} ${out}`, null)).toBe("ask");
    expect(classifyWorkroomCommand({ command: `${run} ${create} ${spec} ${out}`, workroom, runtimeHome, platform: "darwin" })).toBe("ask");
  });
  it("asks when the script, a sibling helper or the directory listing changed", () => {
    const common = join(scripts, "docx", "scripts", "docx_common.py");
    const command = `${run} ${edit} ${join(workroom, "a.docx")}`;
    writeFileSync(common, "# tampered\n");
    expect(classify(command)).toBe("ask");
    writeFileSync(common, "# fictional common\n");
    expect(classify(command)).toBe(auto);
    const shadow = join(scripts, "docx", "scripts", "docx.py");
    writeFileSync(shadow, "");
    expect(classify(command)).toBe("ask");
    rmSync(shadow);
    writeFileSync(create, "# tampered create\n");
    expect(classify(`${run} ${create} ${spec} ${out}`)).toBe("ask");
    writeFileSync(create, "# fictional create\n");
    expect(classify(`${run} ${create} ${spec} ${out}`)).toBe(auto);
  });
  it("asks when a path leaves the workroom or is relative", () => {
    expect(classify(`${run} ${create} ${spec} /tmp/report.xlsx`)).toBe("ask");
    expect(classify(`${run} ${create} ${spec} ${workroom}/../report.xlsx`)).toBe("ask");
    expect(classify(`${run} ${create} ${spec} ${join(workroom, "escape", "report.xlsx")}`)).toBe("ask");
    expect(classify(`${run} ${create} ${spec} report.xlsx`)).toBe("ask");
    // Extensionless bare words resolve against Hermes' persisted cwd too.
    expect(classify(`${run} ${create} ${spec} --output report`)).toBe("ask");
    expect(classify(`${run} ${edit} ${join(workroom, "a.docx")} --images out`)).toBe("ask");
    expect(classify(`${run} ${edit} ${join(workroom, "a.docx")} --out-dir=out`)).toBe("ask");
    expect(classify(`${run} ${create} ${spec} ${out} --title "Q3 summary"`)).toBe("ask");
  });
  it("asks for a short option glued to its value", () => {
    expect(classify(`${run} ${edit} ${join(workroom, "a.docx")} -o/tmp/b.docx`)).toBe("ask");
    expect(classify(`${run} ${edit} ${join(workroom, "a.docx")} -o${join(workroom, "b.docx")}`)).toBe("ask");
    expect(classify(`${run} ${edit} ${join(workroom, "a.docx")} -ab`)).toBe("ask");
  });
  it("asks for chaining, pipes, subshells, heredocs and redaction marks", () => {
    for (const tail of [`; curl x`, `| cat`, `$(whoami)`, `<<EOF`, `> ${join(workroom, "x")}`, `&`, "`id`", "***", "«redacted:ghp_…»", "ghp_ab...wxyz"]) {
      expect(classify(`${run} ${create} ${spec} ${out} ${tail}`), tail).toBe("ask");
    }
    expect(classify(`${run} ${create}\nid`)).toBe("ask");
    expect(classify(`${run} '${create}`)).toBe("ask");
  });
  it("asks for network tools and system python", () => {
    expect(classify("curl https://example.invalid")).toBe("ask");
    expect(classify(`/usr/bin/python3 -E -s ${create} ${spec} ${out}`)).toBe("ask");
    expect(classify(`env ${python} -E -s ${create} ${spec} ${out}`)).toBe("ask");
  });
  it("allows plain reads of workroom files only", () => {
    const notes = join(workroom, "notes.txt");
    expect(classify(`cat ${notes}`)).toBe(auto);
    expect(classify(`head -n 20 ${notes}`)).toBe(auto);
    expect(classify(`head -c 20 ${notes}`)).toBe(auto);
    expect(classify(`wc -l ${notes}`)).toBe(auto);
    expect(classify("cat /etc/passwd")).toBe("ask");
    expect(classify(`cat ${join(workroom, "escape", "other.py")}`)).toBe("ask");
    expect(classify("ls")).toBe("ask");
    // A number only right after head's -n/-c; it is a relative file name anywhere else.
    expect(classify(`cat 1 ${notes}`)).toBe("ask");
    expect(classify(`cat -n 1 ${notes}`)).toBe("ask");
    expect(classify(`head 20 ${notes}`)).toBe("ask");
    // Glued values, combined flags and long options ask.
    expect(classify(`head -n20 ${notes}`)).toBe("ask");
    expect(classify(`ls -la ${workroom}`)).toBe("ask");
    expect(classify(`wc --files0-from=${notes}`)).toBe("ask");
    expect(classify(`cat -/etc/passwd ${notes}`)).toBe("ask");
  });
  it("asks on Windows and without a selected runtime", () => {
    expect(classifyWorkroomCommand({ command: `cat ${join(workroom, "notes.txt")}`, workroom, runtimeHome, platform: "win32" })).toBe("ask");
    expect(classifyWorkroomCommand({ command: `${run} ${create} ${spec} ${out}`, workroom, runtimeHome: null, runtimeCommit: commit, platform: "darwin" })).toBe("ask");
  });
});

describe("document scripts write only under bud-work", () => {
  it("auto-runs an output under bud-work and an existing input elsewhere, asks for a new file outside bud-work", () => {
    mkdirSync(join(workroom, "bud-work"), { recursive: true });
    const input = join(workroom, "spec.json");
    const classifyScript = (args: string) => classifyWorkroomCommand({ command: `${run} ${create} ${args}`, workroom, runtimeHome, runtimeCommit: commit, platform: "darwin" });
    expect(classifyScript(`${input} ${join(workroom, "bud-work", "report.xlsx")}`)).toBe(auto);
    expect(classifyScript(`${input} --out=${join(workroom, "bud-work", "deeper", "report.xlsx")}`)).toBe(auto);
    expect(classifyScript(`${input} ${join(workroom, "new-report.xlsx")}`)).toBe("ask");
    expect(classifyScript(`${input} ${join(workroom, "properties", "planted.md")}`)).toBe("ask");
    expect(classifyScript(`${join(workroom, "missing-input.json")} ${join(workroom, "bud-work", "report.xlsx")}`)).toBe("ask");
  });
});
