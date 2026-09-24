// Native Windows speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// Same CLI contract as the macOS Swift helper:
//   --endpoint-ms N   silence endpointer for call mode
//   --stop-file PATH  cancel without a final transcript
//   --finish-file PATH  finalize and emit the last text
// Built as RealBud Speech.exe so Windows privacy lists attribute mic/speech
// to this helper, not powershell.exe.
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("RealBud Speech")]
[assembly: AssemblyProduct("RealBud")]
[assembly: AssemblyDescription("On-device dictation helper for RealBud")]
[assembly: AssemblyCompany("RealBud")]

internal static class Program
{
    private static int endpointMs;
    private static string stopFile;
    private static string finishFile;
    private static string lastText = "";
    private static DateTime lastChange = DateTime.UtcNow;
    private static bool finishing;
    private static bool stopped;
    private static readonly object Gate = new object();

    private static string Escape(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var sb = new StringBuilder(value.Length + 8);
        foreach (char c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    private static void EmitPartial(bool partial, string text)
    {
        Console.Out.WriteLine(
            "{\"partial\":" + (partial ? "true" : "false") +
            ",\"text\":\"" + Escape(text) + "\"}");
        Console.Out.Flush();
    }

    private static void EmitError(string message)
    {
        Console.Out.WriteLine("{\"error\":\"" + Escape(message) + "\"}");
        Console.Out.Flush();
    }

    private static void Fail(string message)
    {
        EmitError(message);
        Environment.Exit(1);
    }

    private static string ArgValue(string[] args, string flag)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.Ordinal))
                return args[i + 1];
        }
        return null;
    }

    private static int ParseEndpointMs(string[] args)
    {
        string raw = ArgValue(args, "--endpoint-ms");
        int value;
        if (string.IsNullOrEmpty(raw) || !int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            return 0;
        if (value <= 0) return 0;
        if (value < 250) return 250;
        if (value > 5000) return 5000;
        return value;
    }

    private static void Main(string[] args)
    {
        endpointMs = ParseEndpointMs(args);
        stopFile = ArgValue(args, "--stop-file");
        finishFile = ArgValue(args, "--finish-file");

        // A cancelled session must not initialize speech or open the microphone.
        // Those Windows services may block before the polling loop can run.
        if (!string.IsNullOrEmpty(stopFile) && File.Exists(stopFile))
            return;

        SpeechRecognitionEngine engine = null;
        try
        {
            try
            {
                engine = new SpeechRecognitionEngine(CultureInfo.CurrentCulture);
            }
            catch
            {
                engine = new SpeechRecognitionEngine(new CultureInfo("en-US"));
            }
            engine.SetInputToDefaultAudioDevice();
        }
        catch
        {
            Fail("mic-failed");
        }

        try
        {
            engine.LoadGrammar(new DictationGrammar());
        }
        catch
        {
            Fail("recognizer-unavailable");
        }

        engine.SpeechHypothesized += (_, e) =>
        {
            if (e.Result == null || string.IsNullOrEmpty(e.Result.Text)) return;
            lock (Gate)
            {
                lastText = e.Result.Text;
                lastChange = DateTime.UtcNow;
            }
            EmitPartial(true, e.Result.Text);
        };

        engine.SpeechRecognized += (_, e) =>
        {
            if (e.Result == null || string.IsNullOrEmpty(e.Result.Text)) return;
            lock (Gate)
            {
                lastText = e.Result.Text;
                lastChange = DateTime.UtcNow;
            }
            // Keep streaming as partial until finish/stop/endpoint finalizes.
            EmitPartial(true, e.Result.Text);
        };

        engine.RecognizeAsync(RecognizeMode.Multiple);

        while (true)
        {
            if (!string.IsNullOrEmpty(stopFile) && File.Exists(stopFile))
            {
                stopped = true;
                break;
            }

            if (!string.IsNullOrEmpty(finishFile) && File.Exists(finishFile))
            {
                finishing = true;
                break;
            }

            if (endpointMs > 0)
            {
                string text;
                DateTime changed;
                lock (Gate)
                {
                    text = lastText;
                    changed = lastChange;
                }
                if (!string.IsNullOrEmpty(text) &&
                    (DateTime.UtcNow - changed).TotalMilliseconds >= endpointMs)
                {
                    finishing = true;
                    break;
                }
            }

            Thread.Sleep(50);
        }

        try { engine.RecognizeAsyncCancel(); }
        catch { /* best-effort */ }
        Thread.Sleep(150);

        string finalText;
        lock (Gate) { finalText = lastText; }

        if (finishing && !string.IsNullOrEmpty(finalText))
        {
            EmitPartial(false, finalText);
            Environment.Exit(0);
        }

        // Intentional stop with no final, or empty finish — quiet exit.
        if (stopped || finishing)
            Environment.Exit(0);

        Fail("helper-exited");
    }
}
