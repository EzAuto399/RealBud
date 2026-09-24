import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCsc, findSystemSpeech } from "./build-speech-helper-win.mjs";

// Exercise the real helper entry point with a deterministic, rejecting speech
// implementation. A pre-cancelled run must never reach its constructor; the
// uncancelled control proves the fixture would detect that initialization.
const rejectingSpeechSource = String.raw`
using System;
using System.Globalization;
using System.IO;
namespace System.Speech.Recognition {
    public enum RecognizeMode { Multiple }
    public class DictationGrammar { }
    public class RecognitionResult { public string Text { get; set; } }
    public class RecognitionEventArgs : EventArgs { public RecognitionResult Result { get; set; } }
    public class SpeechRecognitionEngine {
        public SpeechRecognitionEngine(CultureInfo culture) {
            File.AppendAllText(Environment.GetEnvironmentVariable("REALBUD_TEST_SPEECH_INITIALIZED"), "constructor\n");
            throw new InvalidOperationException("Fictional speech initialization rejected");
        }
        public void SetInputToDefaultAudioDevice() { }
        public void LoadGrammar(DictationGrammar grammar) { }
        public void RecognizeAsync(RecognizeMode mode) { }
        public void RecognizeAsyncCancel() { }
        public event EventHandler<RecognitionEventArgs> SpeechHypothesized { add { } remove { } }
        public event EventHandler<RecognitionEventArgs> SpeechRecognized { add { } remove { } }
    }
}`;

describe.skipIf(process.platform !== "win32")("native Windows speech helper cancellation before initialization", () => {
  let directory, fakeHelper, nativeHelper;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "RealBud fictional speech "));
    const compiler = findCsc();
    expect(compiler, "Windows speech tests require Framework csc.exe").toBeTruthy();
    const speech = findSystemSpeech();
    expect(speech, "Windows speech tests require System.Speech.dll").toBeTruthy();
    const fixture = join(directory, "rejecting-speech.cs");
    const assembly = join(directory, "FictionalSpeech.dll");
    writeFileSync(fixture, rejectingSpeechSource);
    const compile = args => execFileSync(compiler, ["/nologo", ...args], { timeout: 30_000, windowsHide: true });
    compile(["/target:library", `/out:${assembly}`, fixture]);
    const source = fileURLToPath(new URL("./resources/speech-helper-win.cs", import.meta.url));
    fakeHelper = join(directory, "Fictional Speech.exe");
    nativeHelper = join(directory, "RealBud Speech.exe");
    for (const [target, reference] of [[fakeHelper, assembly], [nativeHelper, speech]]) {
      compile(["/optimize+", "/target:exe", `/out:${target}`, `/r:${reference}`, source]);
    }
  }, 100_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function run(helper, name, { stopped = false, finished = false } = {}) {
    const scratch = join(directory, name); mkdirSync(scratch);
    const stop = join(scratch, "stop ' & %PATH%! 漢字");
    const finish = join(scratch, "finish");
    const initialized = join(scratch, "initialized");
    if (stopped) writeFileSync(stop, "stop");
    if (finished) writeFileSync(finish, "finish");
    const result = spawnSync(helper, ["--stop-file", stop, "--finish-file", finish], {
      encoding: "utf8", timeout: 8000, windowsHide: true,
      env: { ...process.env, REALBUD_TEST_SPEECH_INITIALIZED: initialized },
    });
    expect(result.error).toBeUndefined();
    return { result, initialized };
  }

  it("uncancelled control reaches the rejecting recognizer and reports the normal error", () => {
    const { result, initialized } = run(fakeHelper, "uncancelled");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toEqual({ error: "mic-failed" });
    expect(readFileSync(initialized, "utf8")).toContain("constructor\n");
  }, 10_000);

  it.each([false, true])("existing stop exits quietly without initializing recognition (finish=%s)", finished => {
    const { result, initialized } = run(fakeHelper, `stopped-${finished}`, { stopped: true, finished });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(initialized)).toBe(false);
  }, 10_000);

  it("the helper compiled against real System.Speech exits quietly with the smoke's preexisting stop", () => {
    const { result } = run(nativeHelper, "native-stopped", { stopped: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }, 10_000);
});
