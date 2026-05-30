/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * Only general-purpose is built-in. All other agent types (Explore, Plan, etc.)
 * are defined via custom .md files in ~/.pi/agent/agents/ for full user control.
 */

import type { AgentConfig } from "./types.js";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
]);
