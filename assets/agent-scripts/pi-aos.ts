// AOS gate extension for pi — installed by `aos init --agent pi`.
//
// pi extensions run in-process with the agent; this one is deliberately a
// thin translator: every event is forwarded to `aos hook <name> --agent pi`
// as a subprocess (JSON on stdin, JSON on stdout), so ALL policy stays in the
// AOS core and nothing here can drift from the other agents' gates.
//
// Verified against pi's extension API:
//   tool_call          → { block: true, reason } is a real deny
//   before_agent_start → can inject a message (used once per session for the
//                        AOS context pack)
//   session_shutdown   → best-effort session-end accounting
//
// Fail-open by design (same contract as every AOS hook): a broken or missing
// aos never blocks the session — it lets the call through.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

// Baked at install time as a JSON argv array — [launcher] when the launcher
// is directly executable, [node, launcher] otherwise — so any install path
// (spaces, quotes) survives without shell quoting. Falls back to `aos` on
// PATH only when the baked command cannot be spawned at all.
const AOS_CMD = __AOS_CMD__;

// The aos-side content scan reads at most 100k chars of a write; shipping
// more over stdin is pure latency, so cap the payload at the same budget.
const CONTENT_CAP = 100_000;
// aos hook responses are small JSON; a runaway child must not grow this.
const STDOUT_CAP = 64_000;

function capContent(s: unknown): string {
  const t = typeof s === "string" ? s : "";
  return t.length > CONTENT_CAP ? t.slice(0, CONTENT_CAP) : t;
}

type SpawnResult = { spawned: boolean; response: any | null };

function trySpawn(cmd: string[], args: string[], payload: object, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: any;
    try {
      child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve({ spawned: false, response: null });
      return;
    }
    let out = "";
    let settled = false;
    const done = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ spawned: true, response: null });
    }, timeoutMs);
    // spawn errors (ENOENT/EACCES) mean the baked command is unusable
    child.on("error", () => done({ spawned: false, response: null }));
    child.stdout?.on("data", (d: any) => {
      if (settled) return;
      out += d;
      if (out.length > STDOUT_CAP) {
        try { child.kill(); } catch {}
        done({ spawned: true, response: null });
      }
    });
    child.on("close", () => {
      // empty stdout is a legitimate ALLOW — not a failure
      let response: any = null;
      if (out.trim()) {
        try { response = JSON.parse(out); } catch { response = null; }
      }
      done({ spawned: true, response });
    });
    child.stdin?.on("error", () => {}); // EPIPE if aos died early — close() still fires
    child.stdin?.end(JSON.stringify(payload));
  });
}

async function runAos(args: string[], payload: object, timeoutMs = 10000): Promise<any | null> {
  // Baked command first; PATH fallback only when the bake could not spawn.
  // A successful run — including an empty (allow) response — never retries,
  // so each gate verdict is produced exactly once.
  const r = await trySpawn(AOS_CMD, args, payload, timeoutMs);
  if (r.spawned) return r.response;
  const fallback = await trySpawn(["aos"], args, payload, timeoutMs);
  return fallback.response;
}

function decisionFrom(response: any): { block: boolean; reason: string } {
  const verdict = response?.hookSpecificOutput?.permissionDecision;
  if (verdict === "deny" || verdict === "ask") {
    // "ask" never reaches an unmodified aos install for pi (it converts to an
    // external approval first); treat it as a block if it ever does.
    return {
      block: true,
      reason: String(response?.hookSpecificOutput?.permissionDecisionReason || "blocked by AOS policy"),
    };
  }
  return { block: false, reason: "" };
}

export default function (pi: ExtensionAPI) {
  const cwd = () => process.cwd();
  const sessionId = (ctx: any) => {
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (file) return String(file).split("/").pop();
    } catch {}
    return "pi-session";
  };

  // Args for the audit trail are captured at tool_call time (tool_execution_end
  // carries only toolName/result/isError, not the input). Bounded: a runaway
  // session must not grow this forever.
  const pendingCalls = new Map<string, { name: string; input: any }>();
  const remember = (id: string, name: string, input: any) => {
    if (pendingCalls.size > 256) pendingCalls.delete(pendingCalls.keys().next().value);
    pendingCalls.set(id, { name, input });
  };

  // Gates + audit for shell and file tools.
  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = String(event?.toolName || "");
    let toolName: string | null = null;
    let toolInput: any = {};
    if (name === "bash") {
      toolName = "Bash";
      toolInput = { command: event.input?.command ?? "" };
    } else if (name === "write") {
      toolName = "Write";
      toolInput = { file_path: event.input?.path, content: capContent(event.input?.content) };
    } else if (name === "edit") {
      toolName = "Edit";
      // pi edits carry an array of edits; join the new strings for the
      // content scan, keep the path for the write gates.
      const edits = Array.isArray(event.input?.edits) ? event.input.edits : [];
      toolInput = {
        file_path: event.input?.path,
        content: capContent(edits.map((e: any) => e?.new_string ?? e?.newText ?? "").join("\n")),
      };
    } else {
      // not a gated surface — still remember the args for the audit trail
      remember(String(event?.toolCallId || ""), name, event.input || {});
      return;
    }
    remember(String(event?.toolCallId || ""), name, event.input || {});
    const response = await runAos(["hook", "pre-tool", "--agent", "pi"], {
      session_id: sessionId(ctx),
      cwd: cwd(),
      tool_name: toolName,
      tool_input: toolInput,
    });
    if (response) {
      const d = decisionFrom(response);
      if (d.block) return { block: true, reason: d.reason };
    }
  });

  // Audit trail for every tool call (post-hoc, never blocks). Args come from
  // the tool_call capture (tool_execution_end has none); post-tool needs only
  // the path/command — never ship file content on this path.
  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    const id = String(event?.toolCallId || "");
    const captured = pendingCalls.get(id);
    pendingCalls.delete(id);
    const name = String(event?.toolName || captured?.name || "");
    const input = captured?.input || {};
    let toolName = name;
    let toolInput: any = {};
    if (name === "bash") {
      toolName = "Bash";
      toolInput = { command: String(input.command ?? "").slice(0, 300) };
    } else if (name === "write" || name === "edit") {
      toolName = name === "write" ? "Write" : "Edit";
      toolInput = { file_path: input.path };
    } else {
      toolInput = { keys: Object.keys(input || {}).slice(0, 3) };
    }
    await runAos(["hook", "post-tool", "--agent", "pi"], {
      session_id: sessionId(ctx),
      cwd: cwd(),
      tool_name: toolName,
      tool_input: toolInput,
    });
  });

  // Context injection: once per session file, before the first agent turn.
  let injectedFor: string | null = null;
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const sid = sessionId(ctx);
    if (injectedFor === sid) return;
    const response = await runAos(["hook", "session-start", "--agent", "pi"], {
      session_id: sid,
      cwd: cwd(),
    });
    const context = response?.hookSpecificOutput?.additionalContext;
    if (typeof context === "string" && context.trim()) {
      injectedFor = sid;
      return {
        message: {
          customType: "aos-context",
          content: context,
          display: false,
        },
      };
    }
  });

  // Best-effort session-end accounting (pi has no transcript contract AOS
  // parses today, so this records the boundary, not tokens).
  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    await runAos(["hook", "session-end", "--agent", "pi"], {
      session_id: sessionId(ctx),
      cwd: cwd(),
    });
  });
}
