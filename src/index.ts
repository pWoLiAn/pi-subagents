/**
 * pi-subagents — Core agent orchestration.
 *
 * Tools:
 *   Agent               — spawn a sub-agent
 *   get_subagent_result — check background agent status/result
 *   steer_subagent      — send a steering message to a running agent
 *   kill_subagent       — kill a running or queued agent
 *
 * Commands:
 *   /agents             — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./agent-manager.js";
import {
  getAgentConversation,
  getDefaultMaxTurns,
  getGraceTurns,
  normalizeMaxTurns,
  SUBAGENT_TOOL_NAMES,
  setDefaultMaxTurns,
  setGraceTurns,
  steerAgent,
} from "./agent-runner.js";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  isDefaultsDisabled,
  registerAgents,
  resolveType,
  setDefaultsDisabled,
} from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import {
  applyAndEmitLoaded,
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "./settings.js";
import { getStatusNote } from "./status-note.js";
import {
  type AgentConfig,
  type AgentInvocation,
  type AgentRecord,
  type JoinMode,
  type LifetimeUsage,
  type NotificationDetails,
  type SubagentType,
} from "./types.js";

// ---- Inlined helpers from deleted usage.ts ----

function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

type SessionLike = {
  getSessionStats(): {
    tokens: { input: number; output: number; cacheWrite: number };
    contextUsage?: { percent: number | null };
  };
};

function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}

// ---- Inlined helpers from deleted ui/agent-widget.ts ----

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

function getDisplayName(type: SubagentType): string {
  const cfg = getAgentConfig(type as string);
  return cfg?.displayName ?? (type.charAt(0).toUpperCase() + type.slice(1));
}

// ---- Shared helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session as SessionLike | undefined);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

function buildNotificationDetails(record: AgentRecord, resultMaxLen: number): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: 0,
    maxTurns: undefined,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

export default function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    }
  );

  /** Reload agents from .pi/agents/*.md and merge with defaults. */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  reloadCustomAgents();

  // ---- Cancellable pending notifications ----
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch { /* ignore */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) { clearTimeout(timer); pendingNudges.delete(key); }
  }

  function emitNudge(record: AgentRecord) {
    if (record.resultConsumed) return;
    const notification = formatTaskNotification(record, 500);
    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification,
      display: true,
      details: buildNotificationDetails(record, 500),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendNudge(record: AgentRecord) {
    scheduleNudge(record.id, () => emitNudge(record));
  }

  // ---- Agent manager ----
  const manager = new AgentManager((record) => {
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs: record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt,
    };
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    if (record.resultConsumed) return;
    sendNudge(record);
  }, undefined, (record) => {
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  (globalThis as any)[MANAGER_KEY] = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  };

  let currentCtx: ExtensionContext | undefined;

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted(true);
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("subagents:ready", {});

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
    delete (globalThis as any)[MANAGER_KEY];
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    manager.dispose();
  });

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ---- Disable default agents configuration ----
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents();
  }

  // ---- Tool description mode ----
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Type list helpers ----
  const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
    const tools = cfg?.builtinToolNames;
    if (!tools || tools.length === 0) return "*";
    const isFullSet =
      tools.length === BUILTIN_TOOL_NAMES.length
      && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
    return isFullSet ? "*" : tools.join(", ");
  };

  const buildTypeListText = () => {
    return getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  function getModelLabelFromConfig(model: string): string {
    const name = model.includes("/") ? model.split("/").pop()! : model;
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setSchedulingEnabled: () => {},   // feature removed
      setScopeModels: () => {},          // feature removed
      setDisableDefaultAgents,
      setToolDescriptionMode,
      setFleetView: () => {},            // feature removed
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Tool descriptions ----
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained.
- Parallel work: one message, multiple Agent calls, run_in_background: true on each.
- The result is not shown to the user — summarize it for them.
- resume continues a previous agent by ID; steer_subagent messages a running one.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each.
- When the agent is done, it returns a single message back to you. The result is not visible to the user.
- Trust but verify: an agent's summary describes intent, not outcome.
- Use run_in_background for work you don't need immediately. You will be notified when it completes.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation.`;

  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      scheduleGuideline: () => "",
    };
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
      } catch { /* ignore */ }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
    }
    return fullAgentToolDescription;
  })();

  // ---- Agent tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it.",
      "Trust but verify: an agent's summary describes intent, not outcome.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the agent to perform." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}.`,
      }),
      model: Type.Optional(Type.String({
        description: 'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet").',
      })),
      thinking: Type.Optional(Type.String({
        description: "Thinking level: off, minimal, low, medium, high, xhigh.",
      })),
      max_turns: Type.Optional(Type.Number({
        description: "Maximum number of agentic turns before stopping.",
        minimum: 1,
      })),
      run_in_background: Type.Optional(Type.Boolean({
        description: "Set to true to run in background. Returns agent ID immediately.",
      })),
      resume: Type.Optional(Type.String({
        description: "Optional agent ID to resume from.",
      })),
      isolated: Type.Optional(Type.Boolean({
        description: "If true, agent gets no extension/MCP tools — only built-in tools.",
      })),
      inherit_context: Type.Optional(Type.Boolean({
        description: "If true, fork parent conversation into the agent.",
      })),
    }),

    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      const resolved = resolveType(rawType);
      const subagentType = resolved ?? "general-purpose";
      const fellBack = resolved === undefined;

      const displayName = getDisplayName(subagentType);
      const customConfig = getAgentConfig(subagentType);
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const r = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof r === "string") {
          if (resolvedConfig.modelFromParams) return textResult(r);
        } else {
          model = r;
        }
      }

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());

      const agentInvocation: AgentInvocation = {
        modelName: model?.id !== ctx.model?.id ? model?.id : undefined,
        thinking,
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
      };

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) return textResult(`Agent not found: "${params.resume}".`);
        if (!existing.session) return textResult(`Agent "${params.resume}" has no active session to resume.`);
        const record = await manager.resume(params.resume, params.prompt, signal);
        if (!record) return textResult(`Failed to resume agent "${params.resume}".`);
        return textResult(record.result?.trim() || record.error?.trim() || "No output.");
      }

      // Background execution
      if (runInBackground) {
        let id: string;
        try {
          id = manager.spawn(pi, ctx, subagentType, params.prompt, {
            description: params.description,
            model,
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            isBackground: true,
            invocation: agentInvocation,
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }

        const record = manager.getRecord(id);
        if (record) {
          record.toolCallId = toolCallId;
        }

        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
        );
      }

      // Foreground execution
      let record: AgentRecord;
      try {
        const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          signal,
          invocation: agentInvocation,
        });
        record = fgResult.record;
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const tokenText = formatLifetimeTokens(record);
      const fallbackNote = fellBack
        ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n`
        : "";

      if (record.status === "error") {
        return textResult(`${fallbackNote}Agent failed: ${record.error}`);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
      );
    },
  }));

  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description: "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to check." }),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete before returning." })),
      verbose: Type.Optional(Type.Boolean({ description: "If true, include the agent's full conversation." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}".`);

      if (params.wait && record.status === "running" && record.promise) {
        record.resultConsumed = true;
        cancelNudge(params.agent_id);
        await record.promise;
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session as SessionLike | undefined);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        cancelNudge(params.agent_id);
      }

      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to steer (must be currently running)." }),
      message: Type.String({ description: "The steering message to send." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}".`);
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}).`);
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}.`);
      }
      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session as SessionLike | undefined);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        return textResult(
          `Steering message sent to agent ${record.id}.\nCurrent state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- kill_subagent tool ----

  pi.registerTool(defineTool({
    name: "kill_subagent",
    label: "Kill Agent",
    description:
      "Kill a running or queued background agent immediately. Use when the user asks to stop, kill, or cancel an agent, " +
      "or when an agent is stuck/taking too long.",
    promptSnippet: "Kill a running or queued background agent",
    promptGuidelines: [
      "When the user says to kill, stop, or cancel an agent, use this tool immediately.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to kill (must be running or queued)." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}".`);
      if (record.status !== "running" && record.status !== "queued") {
        return textResult(`Agent "${params.agent_id}" is not running or queued (status: ${record.status}).`);
      }
      const wasStatus = record.status;
      const success = manager.abort(params.agent_id);
      if (success) {
        pi.events.emit("subagents:killed", { id: params.agent_id });
        return textResult(`Agent ${params.agent_id} killed (was ${wasStatus}).`);
      }
      return textResult(`Failed to kill agent ${params.agent_id}.`);
    },
  }));

  // ---- /agents interactive menu ----

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    if (registry) {
      const resolved = resolveModel(cfg.model, registry);
      if (typeof resolved === "string") return "inherit";
    }
    return getModelLabelFromConfig(cfg.model);
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();
    const options: string[] = [];

    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    if (allNames.length > 0) options.push(`Agent types (${allNames.length})`);
    options.push("Create new agent");
    options.push("Settings");

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) { ctx.ui.notify("No agents.", "info"); return; }

    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const entries = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      const indicator = sourceIndicator(cfg);
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map(e => e.prefix.length));

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

    const options = entries.map(({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`);
    if (legend) options.push(legend);

    const choice = await ctx.ui.select("Agent types", options);
    if (!choice) return;

    const agentName = choice.split(" · ")[0].replace(/^[•◦✕\s]+/, "").trim();
    if (getAgentConfig(agentName)) {
      await showAgentDetail(ctx, agentName);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) { ctx.ui.notify("No agents.", "info"); return; }

    const options = agents.map(a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });

    const choice = await ctx.ui.select("Running agents", options);
    if (!choice) return;

    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    const isActive = record.status === "running" || record.status === "queued";
    const actions: string[] = [];
    if (isActive) actions.push("Kill agent");

    if (actions.length === 0) { await showRunningAgents(ctx); return; }

    const action = await ctx.ui.select(`${getDisplayName(record.type)} (${record.status})`, actions);
    if (!action) { await showRunningAgents(ctx); return; }

    if (action === "Kill agent") {
      manager.abort(record.id);
      pi.events.emit("subagents:killed", { id: record.id });
      ctx.ui.notify(`Agent ${record.id} killed.`, "info");
    }

    await showRunningAgents(ctx);
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) { ctx.ui.notify(`Agent config not found for "${name}".`, "warning"); return; }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete" && file) {
      const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
      if (confirmed) { unlinkSync(file.path); reloadCustomAgents(); ctx.ui.notify(`Deleted ${file.path}`, "info"); }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) { unlinkSync(file.path); reloadCustomAgents(); ctx.ui.notify(`Restored default ${name}`, "info"); }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const fmFields: string[] = [];
    fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) { ctx.ui.notify(`${name} is already disabled.`, "info"); return; }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;
    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;
    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;
    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;
    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }
    ctx.ui.notify("Generating agent definition...", "info");
    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"\n\nWrite a markdown file to: ${targetPath}\n\nOnly write the file using the write tool.`;
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
    });
    if (record.status === "error") { ctx.ui.notify(`Generation failed: ${record.error}`, "warning"); return; }
    reloadCustomAgents();
    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;
    let tools: string;
    if (toolChoice === "all") tools = BUILTIN_TOOL_NAMES.join(", ");
    else if (toolChoice === "none") tools = "none";
    else if (toolChoice.startsWith("read-only")) tools = "read, bash, grep, find, ls";
    else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }
    const modelChoice = await ctx.ui.select("Model", ["inherit (parent model)", "haiku", "sonnet", "opus", "custom..."]);
    if (!modelChoice) return;
    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: claude-haiku-4.5";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: claude-sonnet-4.6";
    else if (modelChoice === "opus") modelLine = "\nmodel: claude-opus-4.6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }
    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]);
    if (!thinkingChoice) return;
    const thinkingLine = thinkingChoice !== "inherit" ? `\nthinking: ${thinkingChoice}` : "";
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;
    const content = `---\ndescription: ${description}\ntools: ${tools}${modelLine}${thinkingLine}\nprompt_mode: replace\n---\n\n${systemPrompt}\n`;
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
    };
  }

  const NUMERIC_IDS = new Set(["maxConcurrent", "defaultMaxTurns", "graceTurns"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "Default join mode for background agents",
          currentValue: getDefaultJoinMode(),
          values: ["smart", "async", "group"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide built-in agents (general-purpose) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description mode: full, compact, or custom",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) { manager.setMaxConcurrent(n); notifyApplied(ctx, `Max concurrency set to ${n}`); }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) { setDefaultMaxTurns(undefined); notifyApplied(ctx, "Default max turns set to unlimited"); }
        else if (n >= 1) { setDefaultMaxTurns(n); notifyApplied(ctx, `Default max turns set to ${n}`); }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) { setGraceTurns(n); notifyApplied(ctx, `Grace turns set to ${n}`); }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}.`);
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      }
    }

    let list: SettingsList;
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();
      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => { applyValue(id, newValue); },
        () => done(undefined as undefined),
      );
      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          const items = buildItems();
          if (matchesKey(data, "up")) currentIndex = Math.max(0, currentIndex - 1);
          else if (matchesKey(data, "down")) currentIndex = Math.min(items.length - 1, currentIndex + 1);
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : String(getGraceTurns());
      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : "Grace turns (1+)";
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) { applyValue(result, String(n)); await showSettings(ctx); return; }
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
