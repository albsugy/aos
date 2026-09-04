// AOS gate plugin for opencode — installed by `aos init --agent opencode`.
//
// opencode plugins run in-process (Bun) with the agent; this one is
// deliberately a thin translator: `tool.execute.before` forwards the call to
// `aos hook pre-tool --agent opencode` as a subprocess, and a deny verdict is
// surfaced by THROWING — opencode's documented blocking mechanism; the error
// message is fed to the agent. All policy stays in the AOS core.
//
// Verified against opencode's plugin API:
//   tool.execute.before  → throw blocks the call (real deny); args are read
//                          from output.args (the documented, mutable copy)
//   tool.execute.after   → audit, never blocks
//   plugin args          → { directory } is the project cwd
//
// Fail-open by design (same contract as every AOS hook): a broken or missing
// aos never blocks the session.

import type { Plugin } from "@opencode-ai/plugin";
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

export const AosPlugin: Plugin = async ({ directory }) => {
  const cwd = () => directory || process.cwd();

  return {
    "tool.execute.before": async (input: any, output: any) => {
      // opencode hands the tool args in output.args (mutable); read the
      // documented copy, fall back to input.args for older builds.
      const args = output?.args ?? input?.args ?? {};
      const tool = String(input?.tool || "");
      let toolName: string | null = null;
      let toolInput: any = {};
      if (tool === "bash") {
        toolName = "Bash";
        toolInput = { command: args.command ?? "" };
      } else if (tool === "write") {
        toolName = "Write";
        toolInput = { file_path: args.filePath, content: capContent(args.content) };
      } else if (tool === "edit") {
        toolName = "Edit";
        toolInput = { file_path: args.filePath, content: capContent(args.newString) };
      } else if (tool === "apply_patch" || tool === "patch") {
        // GPT-5-series models get apply_patch instead of write/edit. Docs
        // briefly listed this as "patch"; both names are gated. Paths live in
        // patchText marker lines, not filePath.
        toolName = "apply_patch";
        toolInput = { patchText: capContent(args.patchText ?? args.command ?? "") };
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

    "tool.execute.after": async (input: any, output: any) => {
      const args = output?.args ?? input?.args ?? {};
      const tool = String(input?.tool || "");
      let toolName = tool;
      let toolInput: any = {};
      if (tool === "bash") {
        toolName = "Bash";
        toolInput = { command: String(args.command ?? "").slice(0, 300) };
      } else if (tool === "write" || tool === "edit") {
        toolName = tool === "write" ? "Write" : "Edit";
        toolInput = { file_path: args.filePath };
      } else if (tool === "apply_patch" || tool === "patch") {
        toolName = "apply_patch";
        toolInput = { patchText: capContent(args.patchText ?? args.command ?? "") };
      } else {
        toolInput = { keys: Object.keys(args || {}).slice(0, 3) };
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
