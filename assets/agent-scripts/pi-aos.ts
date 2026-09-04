// AOS gate extension for pi — installed by `aos init --agent pi`.
//
// pi extensions run in-process with the agent; this one is deliberately a
// thin translator: every event is forwarded to `aos hook <name> --agent pi`
// as a subprocess (JSON on stdin, JSON on stdout), so ALL policy stays in the
// AOS core and nothing here can drift from the other agents' gates.
//
// Verified against pi's extension API:
//   tool_call        → { block: true, reason } is a real deny
//   before_agent_start → can inject a message (used once per session for the
//                      AOS context pack)
//   session_shutdown → best-effort session-end accounting
//
// Fail-open by design (same contract as every AOS hook): a broken or missing
// aos never blocks the session — it logs to stderr and lets the call through.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

// Baked at install time; the PATH fallback keeps the extension working after
// reinstalls to a new location.
const AOS_BIN = "__AOS_BIN__";

function trySpawn(bin: string, args: string[], payload: object, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    let child: any;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(null);
    }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.stdout?.on("data", (d: any) => (out += d));
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(null); }
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

async function runAos(args: string[], payload: object, timeoutMs = 10000): Promise<any | null> {
  // Baked launcher first, PATH fallback second; never throws — fail-open.
  if (AOS_BIN !== "__AOS_BIN__") {
    const r = await trySpawn(AOS_BIN, args, payload, timeoutMs);
    if (r !== null) return r;
  }
  return trySpawn("aos", args, payload, timeoutMs);
}

function decisionFrom(response: any): { block: boolean; reason: string } {
  const verdict = response?.hookSpecificOutput?.permissionDecision;
  if (verdict === "deny" || verdict === "ask") {
    // "ask" never reaches an unmodified aos install for pi (it converts to an
    // external approval first); treat it as a block if it ever does.
    return { block: true, reason: String(response?.hookSpecificOutput?.permissionDecisionReason || "blocked by AOS policy") };
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
      toolInput = { file_path: event.input?.path, content: event.input?.content ?? "" };
    } else if (name === "edit") {
      toolName = "Edit";
      // pi edits carry an array of edits; join the new strings for the
      // content scan, keep the path for the write gates.
      const edits = Array.isArray(event.input?.edits) ? event.input.edits : [];
      toolInput = {
        file_path: event.input?.path,
        content: edits.map((e: any) => e?.new_string ?? e?.newText ?? "").join("\n"),
      };
    } else {
      return; // not a gated surface
    }
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

  // Audit trail for every tool call (post-hoc, never blocks).
  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    const name = String(event?.toolName || "");
    let toolInput: any = {};
    if (name === "bash") toolInput = { command: event.input?.command ?? "" };
    else if (name === "write") toolInput = { file_path: event.input?.path, content: event.input?.content ?? "" };
    else if (name === "edit") toolInput = { file_path: event.input?.path };
    else toolInput = { keys: Object.keys(event.input || {}).slice(0, 3) };
    await runAos(["hook", "post-tool", "--agent", "pi"], {
      session_id: sessionId(ctx),
      cwd: cwd(),
      tool_name: name === "bash" ? "Bash" : name === "write" ? "Write" : name === "edit" ? "Edit" : name,
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
