// AOS gate plugin for opencode — installed by `aos init --agent opencode`.
//
// opencode plugins run in-process (Bun) with the agent; this one is
// deliberately a thin translator: `tool.execute.before` forwards the call to
// `aos hook pre-tool --agent opencode` as a subprocess, and a deny verdict is
// surfaced by THROWING — opencode's documented blocking mechanism; the error
// message is fed to the agent. All policy stays in the AOS core.
//
// Verified against opencode's plugin API:
//   tool.execute.before  → throw blocks the call (real deny)
//   tool.execute.after   → audit, never blocks
//   plugin args          → { directory } is the project cwd
//
// Fail-open by design (same contract as every AOS hook): a broken or missing
// aos never blocks the session.

import type { Plugin } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";

// Baked at install time; the PATH fallback keeps the plugin working after
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

export const AosPlugin: Plugin = async ({ directory }) => {
  const cwd = () => directory || process.cwd();

  return {
    "tool.execute.before": async (input: any) => {
      const tool = String(input?.tool || "");
      let toolName: string | null = null;
      let toolInput: any = {};
      if (tool === "bash") {
        toolName = "Bash";
        toolInput = { command: input.args?.command ?? "" };
      } else if (tool === "write") {
        toolName = "Write";
        toolInput = { file_path: input.args?.filePath, content: input.args?.content ?? "" };
      } else if (tool === "edit") {
        toolName = "Edit";
        toolInput = { file_path: input.args?.filePath, content: input.args?.newString ?? "" };
      } else {
        return; // not a gated surface
      }
      const response = await runAos(["hook", "pre-tool", "--agent", "opencode"], {
        session_id: input?.sessionID ?? null,
        cwd: cwd(),
        tool_name: toolName,
        tool_input: toolInput,
      });
      const verdict = response?.hookSpecificOutput?.permissionDecision;
      if (verdict === "deny" || verdict === "ask") {
        // throw = block; the reason is what the agent sees
        throw new Error(
          String(response?.hookSpecificOutput?.permissionDecisionReason || "blocked by AOS policy")
        );
      }
    },

    "tool.execute.after": async (input: any) => {
      const tool = String(input?.tool || "");
      let toolName = tool;
      let toolInput: any = {};
      if (tool === "bash") {
        toolName = "Bash";
        toolInput = { command: input.args?.command ?? "" };
      } else if (tool === "write") {
        toolName = "Write";
        toolInput = { file_path: input.args?.filePath, content: input.args?.content ?? "" };
      } else if (tool === "edit") {
        toolName = "Edit";
        toolInput = { file_path: input.args?.filePath };
      } else {
        toolInput = { keys: Object.keys(input.args || {}).slice(0, 3) };
      }
      await runAos(["hook", "post-tool", "--agent", "opencode"], {
        session_id: input?.sessionID ?? null,
        cwd: cwd(),
        tool_name: toolName,
        tool_input: toolInput,
      });
    },
  };
};
