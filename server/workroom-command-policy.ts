// Which Hermes terminal commands may run without a per-instance approval card
// (docs/decisions/2026-10-02-workroom-script-approvals.md). Only two shapes are
// `auto`: one reviewed bundled document script run as
// `<runtimeHome>/hermes-agent/venv/bin/python3 -E -s <script> ...` from a
// pinned runtime commit whose scripts directory hashes match, or a plain
// cat/head/wc/ls of workroom files. Everything else, including anything that
// does not parse cleanly, is `ask`.
//
// The command is Hermes' *redacted* display text, not necessarily the exact
// argv that will run. Hermes masks secrets as `***`, `«redacted:…»` or
// `abcd...wxyz`; `*`, `«`, `»`, `…` and `..` all force `ask`, so a masked
// command never auto-runs.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { BUD_WORK_FOLDER } from "./vault.ts";

export type WorkroomCommandDecision = "auto" | "ask";

export interface WorkroomCommandInput {
  command: string;
  /** `<DATA_DIR>/vault`. */
  workroom: string;
  /** The selected, verified Hermes runtime home (`ownedRuntimeHome()`), or null. */
  runtimeHome: string | null;
  /** Full git commit of the selected runtime; scripts ask unless it is pinned below. */
  runtimeCommit?: string | null;
  platform?: NodeJS.Platform;
}

// Entry points that may auto-run. Not listed, by design: extract_marker.py
// (downloads models); xlsx_recalc.py, pptx_render.py, pdf_page_image.py,
// _raster.py and pdf_form_layout.py (imports _raster) resolve programs through
// PATH; extract_pymupdf.py (`--images` alone writes to ./images, relative to
// Hermes' persisted cwd); pptx_render.py also defaults --outdir to `render`.
const REVIEWED_SCRIPTS: Record<string, string[]> = {
  xlsx: ["csv_to_xlsx.py", "xlsx_create.py", "xlsx_edit.py", "xlsx_read.py", "xlsx_restructure.py", "xlsx_to_csv.py"],
  docx: ["docx_comments.py", "docx_create.py", "docx_edit.py", "docx_read.py", "docx_revisions.py", "docx_template.py", "docx_validate.py"],
  pdf: ["pdf_create.py", "pdf_fill_form.py", "pdf_make_form.py", "pdf_merge.py", "pdf_meta.py", "pdf_read.py", "pdf_secure.py", "pdf_split.py", "pdf_stamp.py", "pdf_watermark.py"],
  powerpoint: ["pptx_create.py", "pptx_edit.py", "pptx_from_template.py", "pptx_read.py"],
};

// sha256 of every file in each skill's scripts/ directory. Python puts the
// script's directory first on sys.path, so a changed sibling (`docx_common.py`)
// or any new file there (a shadowing `docx.py`, a `__pycache__`) must ask.
// Identical in Hermes 0.21.3 (345cd2b0) and 0.21.5 (f97608f1).
const SCRIPTS_0_21: Record<string, Record<string, string>> = {
  xlsx: {
    "csv_to_xlsx.py": "c92331ed358a8ba762a67b408c594d4c12f19f571087a3605203fb68d8c8ca70",
    "xlsx_create.py": "29d797b1cdb6a51ed72e13aca5e891fc4d281825344f895719136ab360a4e92f",
    "xlsx_edit.py": "05e9c12fa66610bf53909691c6852a7ee38216a6ffd018c0e4ac2da173ae6bd4",
    "xlsx_read.py": "5f8dc99437e4b65d72cac4f99ef25d383b477926d5ae31e0e8aae6fa3266d935",
    "xlsx_recalc.py": "e61d8ab12a330a1efd4339bcc419a2a2793bd9a64b87f264580f732cae62dbfa",
    "xlsx_restructure.py": "062871f70d1c09d105f4aa4b1d3b420238b2997c8d52d1cfaa8e8cacdb1756db",
    "xlsx_to_csv.py": "1be6a866b20199e2b42e8937ad2ecfa2055c9877a34dac1b597bfa1d930720ea",
  },
  docx: {
    "docx_comments.py": "6687c2f8b8e4cdd2ea9d70da668417e8c26f30dead2b1a4b7bda07e34fbf67cf",
    "docx_common.py": "5f915ce8138d19344f80b218b3e81aac8332dc6b560774a6f2a9757f4fc2eaea",
    "docx_create.py": "8391869c97ab804374dddadff4fbebc060120c0b973d06133f84487cc2c442d5",
    "docx_edit.py": "00feef0a58a318406077020a017dd0b2673daaef93e0bda81fa9437b237180ff",
    "docx_read.py": "4760617eea1b17d648f7a46f6718c22ec4a76a359e8f0ee9f6ffe921df9129de",
    "docx_revisions.py": "0b835b76b86a1a7bf607c7724a09a71af788cacec48058ae99b04dba6950b938",
    "docx_template.py": "aed1b1db212b72995bd47a28e6c9928a4d02d7596615f1dadf12cd43a4f34219",
    "docx_validate.py": "64d4197ac4aa555384efaefa1cc392a863e2d05489acc04776c33ab1a591d024",
  },
  pdf: {
    "_raster.py": "17ecfb8dd78b006e904d0f29e28172ce308a34588db99ec80b0f085d2a37b518",
    "extract_marker.py": "a115ee1da5b88f7ab61c480ef9efb2b371350bed8f1cface7668898ba80aae38",
    "extract_pymupdf.py": "784d233ee9849ce78cddc8253c87172c06a0b62c41aff7215fd97b77766babc8",
    "pdf_create.py": "2a7a7c06c608e82cc11684bb67ff9cdb3bf8cbe6df38c6f4b1096dd2686f993c",
    "pdf_fill_form.py": "d66d504d7f7fcb85c28881065c47dfbc6ac9b47294471531a7f013178c72a1ad",
    "pdf_form_layout.py": "f654e386a8b1e5a26a1530b16d36177310dd48c6cb589ec6cf3dc1898a8ccdf9",
    "pdf_make_form.py": "a194791f2d6504da9e629976620ac227a18a6ea14784d428c4cf4f57fafd6c3d",
    "pdf_merge.py": "c1cf231f73b02790069227a4f711475b4b329c91e30e77826f24c05935674248",
    "pdf_meta.py": "989c2564bb31d8b20abd53a4d7f86a603c930bd868e0201ad4cdec92d5487460",
    "pdf_page_image.py": "40ad843fd50bd6bd91af1fd53de1cff1faf885921294afd304d0abf0fe93e4e2",
    "pdf_read.py": "7d623cbbb6319f9f161dd769972250b08c426c291ed0af1a8304bec20437bfb2",
    "pdf_secure.py": "65d0ba6733cb945e6147e4b46e0b6db0816096440b0f4fe24cc953307805e01b",
    "pdf_split.py": "1e3d8f8e9aa8aa5445f8587e402e3bab65c785eb5b4aea120bc5b6216cb57cba",
    "pdf_stamp.py": "e3bf6e29634be35ff99fee8a21a3e5f4f610298cb158942496d0949f0a941390",
    "pdf_watermark.py": "d903977ee37194ad18bba205d2d96eefbbe6670519bcd8ae285f619645005ae2",
  },
  powerpoint: {
    "pptx_create.py": "90e60c1fad8c5e7c209acf6ecdebee43c26609bbcf9a7dc063207ad8a3091485",
    "pptx_edit.py": "feb5b09546f9f7fb5dfb4c9b2596b3acbaff9c021faf1985c42f618be0476f3f",
    "pptx_from_template.py": "8537205a777ba541c826082a4395066881dfa63c3033151127b82a8fd82fdb8f",
    "pptx_read.py": "b2a6e246e40a6728e5e0e8bf2c4cbe4f788ab8c40bdb1b89e339571a34fdbc71",
    "pptx_render.py": "49ebe77fa453b5fb21e0a39c0601187399c26f60a399726744277ee098f06dd7",
  },
};
// Exported for tests, which register a fictional commit; never extended at runtime.
export const PINNED_SCRIPTS: Record<string, Record<string, Record<string, string>>> = {
  "345cd2b057a452236de401d3534b8502a7465e8d": SCRIPTS_0_21,
  "f97608f178d1ffeca59860195ab7da295f7c8e5f": SCRIPTS_0_21,
};
const READ_COMMANDS = new Set(["cat", "head", "wc", "ls"]);
// Shell metacharacters, expansions, globs, comments, history, escapes and
// Hermes' redaction marks. Rejected anywhere in the command, quoted or not.
const UNSAFE = /[;&|<>$`()\\\n\r\0*?[\]{}~!#«»…]/;

/** Simple shell words: whitespace-separated, single or double quotes allowed,
 * no expansions or escapes (UNSAFE already rejected those). Null if unbalanced. */
export function shellWords(command: string): string[] | null {
  if (UNSAFE.test(command)) return null;
  const words: string[] = [];
  let word = "", inWord = false, quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

/** realpath of the deepest existing ancestor, with the missing tail appended:
 * a symlink anywhere along an existing prefix is followed. */
function resolveReal(path: string): string | null {
  let existing = path;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...tail);
  } catch {
    return null;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** An absolute path whose real location is inside the real workroom. Relative
 * paths ask: Hermes' terminal carries `cd` across commands, so RealBud cannot
 * know which directory a relative path would resolve against. */
function workroomPath(arg: string, workroom: string): boolean {
  if (!isAbsolute(arg)) return false;
  const root = resolveReal(workroom), target = resolveReal(arg);
  return Boolean(root && target && (target === root || inside(root, target)));
}

const SHORT_FLAG = /^-[A-Za-z]$/;
const LONG_FLAG = /^--[A-Za-z][A-Za-z0-9-]*$/;

/** A script may read anywhere in the workroom but write only under Bud's
 * own `bud-work` folder (the only part of the workroom the sandbox lets it
 * write). An argument naming a file that does not exist yet is an output, so
 * it must sit under `bud-work`; an existing file elsewhere is an input. */
function scriptPath(arg: string, workroom: string): boolean {
  if (!workroomPath(arg, workroom)) return false;
  const root = resolveReal(workroom), target = resolveReal(arg);
  if (!root || !target) return false;
  const budWork = join(root, BUD_WORK_FOLDER);
  return target === budWork || inside(budWork, target) || existsSync(target);
}

/** Every word is exactly `-x`, `--long`, `--long=<workroom path>` or an
 * absolute workroom path. A glued short option (`-o/etc/x`) asks, and so does
 * any bare word: argparse would resolve it against Hermes' persisted cwd. */
function argumentsStayInWorkroom(args: string[], workroom: string): boolean {
  return args.every((arg) => {
    if (SHORT_FLAG.test(arg) || LONG_FLAG.test(arg)) return true;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) return LONG_FLAG.test(arg.slice(0, eq)) && scriptPath(arg.slice(eq + 1), workroom);
    return !arg.startsWith("-") && scriptPath(arg, workroom);
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** An allowlisted entry script whose scripts/ directory matches, file for
 * file, the hashes pinned for this runtime commit. */
function reviewedScript(path: string, runtimeHome: string, runtimeCommit: string): boolean {
  const pinned = PINNED_SCRIPTS[runtimeCommit];
  if (!pinned || !isAbsolute(path)) return false;
  try {
    const real = realpathSync(path), name = basename(real);
    if (name !== basename(path)) return false;
    const skillsRoot = realpathSync(join(runtimeHome, "hermes-agent", "skills", "productivity"));
    const skill = Object.keys(REVIEWED_SCRIPTS).find((key) => dirname(real) === join(skillsRoot, key, "scripts"));
    if (!skill || !REVIEWED_SCRIPTS[skill].includes(name)) return false;
    const dir = dirname(real), expected = pinned[skill], present = readdirSync(dir);
    if (present.length !== Object.keys(expected).length) return false;
    return present.every((file) => expected[file] !== undefined && lstatSync(join(dir, file)).isFile() && sha256(join(dir, file)) === expected[file]);
  } catch {
    return false;
  }
}

/** Only the literal absolute venv interpreter: Hermes persists `export PATH`
 * between commands, so a bare `python3` may be anything. */
function runtimePython(program: string, runtimeHome: string): boolean {
  const venvBin = join(runtimeHome, "hermes-agent", "venv", "bin");
  return [join(venvBin, "python3"), join(venvBin, "python")].includes(program) && existsSync(program);
}

export function classifyWorkroomCommand({ command, workroom, runtimeHome, runtimeCommit = null, platform = process.platform }: WorkroomCommandInput): WorkroomCommandDecision {
  // Windows quoting (cmd/PowerShell) differs enough that mirroring is not worth the risk.
  if (platform === "win32" || sep !== "/") return "ask";
  const words = shellWords(command);
  if (!words?.length || words.some((word) => !word || word.includes(".."))) return "ask";
  const [program, ...args] = words;
  if (READ_COMMANDS.has(program)) {
    // Single-letter flags only (no `--files0-from`), a count only right after
    // head's -n/-c, and every other word a workroom file; at least one named.
    let files = 0;
    const ok = args.every((arg, index) => {
      if (SHORT_FLAG.test(arg)) return true;
      if (/^[0-9]+$/.test(arg)) return program === "head" && ["-n", "-c"].includes(args[index - 1]);
      files += 1;
      return workroomPath(arg, workroom);
    });
    return ok && files > 0 ? "auto" : "ask";
  }
  // `-E -s` ignores PYTHON* variables (PYTHONPATH, PYTHONSTARTUP) and the user
  // site; not `-I`, which drops the script directory the sibling imports need.
  if (!runtimeHome || !runtimeCommit || !runtimePython(program, runtimeHome)) return "ask";
  const [e, s, script, ...scriptArgs] = args;
  if (e !== "-E" || s !== "-s" || !script || !reviewedScript(script, runtimeHome, runtimeCommit)) return "ask";
  return argumentsStayInWorkroom(scriptArgs, workroom) ? "auto" : "ask";
}
