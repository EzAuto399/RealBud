"""Version-admitted assigned-case runner. Secrets cross an anonymous pipe, never a file.

The resolver process may read the selected profile's inference configuration. A
second interpreter imports the agent only after its home and environment have
been replaced. Private config cannot survive through module caches.
"""
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

LIMIT = 128 * 1024


def request():
    value = json.loads(sys.stdin.buffer.read(LIMIT + 1))
    if not isinstance(value, dict):
        raise ValueError("request")
    return value


def clean_environment(home):
    result = {key: os.environ[key] for key in (
        "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL",
    ) if key in os.environ}
    result.update(HOME=home, USERPROFILE=home, HERMES_HOME=home,
                  TMPDIR=home, TMP=home, TEMP=home, PYTHON_DOTENV_DISABLED="1",
                  HERMES_IGNORE_RULES="1",
                  HERMES_SAFE_MODE="1", HERMES_ACP_SKIP_CONFIGURED_MCP="1",
                  HERMES_EXEC_ASK="1", PYTHONDONTWRITEBYTECODE="1")
    return result


def resolve(request):
    # Never auto-select or invoke an external CLI/provider on this path. OAuth,
    # opaque pools and cloud SDK routing need their own isolated adapter proof.
    from hermes_cli.config import require_parseable_user_config, load_config_readonly, get_env_value_prefer_dotenv
    require_parseable_user_config()
    config = load_config_readonly()
    model_config = config.get("model", {})
    model, provider = model_config.get("default"), model_config.get("provider")
    if not isinstance(model, str) or not model or not isinstance(provider, str):
        raise ValueError("routing")
    supported = {"custom", "openrouter", "openai", "deepseek", "anthropic", "kimi", "moonshot"}
    if provider not in supported or model.startswith(("moa:", "http:", "https:")):
        raise ValueError("routing")
    from hermes_cli.runtime_provider import resolve_runtime_provider
    key_env = {"custom": "OPENAI_API_KEY", "openai": "OPENAI_API_KEY", "openrouter": "OPENROUTER_API_KEY",
               "deepseek": "DEEPSEEK_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "kimi": "KIMI_API_KEY", "moonshot": "MOONSHOT_API_KEY"}[provider]
    profile_key = get_env_value_prefer_dotenv(key_env)
    if not isinstance(profile_key, str) or not profile_key:
        raise ValueError("routing")
    route = resolve_runtime_provider(requested=provider, target_model=model, explicit_api_key=profile_key,
                                     explicit_base_url=model_config.get("base_url") or None)
    if route.get("api_key") != profile_key:
        raise ValueError("routing")
    # Other wire protocols need their own native relay captures before admission.
    if route.get("provider") != provider or route.get("api_mode") != "chat_completions":
        raise ValueError("routing")
    if route.get("credential_pool") is not None or route.get("command") or route.get("extra_headers"):
        raise ValueError("routing")
    from urllib.parse import urlsplit
    endpoint = route.get("base_url")
    if not isinstance(endpoint, str):
        raise ValueError("routing")
    parsed = urlsplit(endpoint)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not (
        parsed.scheme == "https" or parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    ):
        raise ValueError("routing")
    key = route.get("api_key")
    if not isinstance(key, str) or not key or len(key) > 16384:
        raise ValueError("routing")
    return {"model": model, "provider": provider, "requested_provider": provider,
            "base_url": endpoint, "api_key": key, "api_mode": route["api_mode"]}


def run_isolated(value):
    # No inherited configuration, dotenv, user home, prefill or prior sessions.
    from run_agent import AIAgent
    route = value["route"]
    agent = AIAgent(**route, enabled_toolsets=["todo"], max_iterations=value["maxTurns"],
                    skip_context_files=True, skip_memory=True, skip_background_review=True,
                    load_soul_identity=False, ephemeral_system_prompt=None, prefill_messages=None,
                    fallback_model=None, credential_pool=None, session_db=None,
                    session_id=str(uuid.uuid4()), save_trajectories=False, checkpoints_enabled=False,
                    quiet_mode=True, verbose_logging=False, platform="realbud-department")
    if agent.model != route["model"] or agent.provider != route["provider"] or agent.base_url.rstrip("/") != route["base_url"].rstrip("/"):
        raise ValueError("routing changed")
    if agent.valid_tool_names != {"todo_list"}:
        raise ValueError("tools changed")
    result = agent.run_conversation(value["prompt"], conversation_history=[])
    if result.get("failed") or result.get("error") or result.get("completed") is not True:
        raise ValueError("incomplete")
    answer = result.get("final_response")
    if not isinstance(answer, str) or not answer or len(answer.encode("utf-8")) > LIMIT:
        raise ValueError("response")
    return {"ok": True, "stdout": answer}


def main():
    value = request()
    runtime = Path(value["runtimeDirectory"])
    sys.path.insert(0, str(runtime))
    # Every Python socket is restricted to the authenticated relay. This also
    # refuses implicit metadata, fallback and credential-refresh egress.
    from urllib.parse import urlsplit
    relay = urlsplit(value.get("relayUrl") or value.get("route", {}).get("base_url", ""))
    if relay.hostname != "127.0.0.1" or not relay.port:
        raise ValueError("relay")
    def socket_boundary(event, args):
        if event == "socket.connect" and (not isinstance(args[1], tuple) or args[1][:2] != ("127.0.0.1", relay.port)):
            raise PermissionError("isolated transport")
        if event == "socket.getaddrinfo" and (args[0] != "127.0.0.1" or int(args[1]) != relay.port):
            raise PermissionError("isolated transport")
    sys.addaudithook(socket_boundary)
    # Diagnostics may contain provider credentials or case text. They are never
    # returned to the application. The stdout protocol contains only the answer.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        if value.get("isolated") is True:
            result = run_isolated(value)
        else:
            route = resolve(value)
            from urllib.request import Request, urlopen
            configure = Request(value["relayUrl"] + "/configure", data=json.dumps(route).encode("utf-8"),
                                headers={"Authorization": "Bearer " + value["relayToken"], "Content-Type": "application/json"}, method="POST")
            with urlopen(configure, timeout=10) as response:
                if response.status != 200:
                    raise ValueError("relay")
            route["api_key"], route["base_url"] = value["relayToken"], value["relayUrl"]
            home = str(Path.cwd())
            # Only an app-owned constant is written, never profile config.
            Path(home, "config.yaml").write_text("tools:\n  tool_search:\n    enabled: off\n", encoding="utf-8")
            child_input = {"isolated": True, "runtimeDirectory": str(runtime), "route": route,
                           "prompt": value["prompt"], "maxTurns": value["maxTurns"]}
            child = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).resolve())],
                                   input=json.dumps(child_input), text=True, encoding="utf-8",
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   cwd=home, env=clean_environment(home), check=True)
            if len(child.stdout.encode("utf-8")) > LIMIT:
                raise ValueError("response")
            result = json.loads(child.stdout)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Deliberately bounded and independent of exception/provider messages.
        print(json.dumps({"ok": False, "detail": "This worker route cannot prepare an isolated department case. Check the supported worker setup."}))
        sys.exit(1)
