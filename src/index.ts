import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type MessageRenderer,
  type ModelRegistry,
  type RegisteredCommand,
  type SessionEntry,
  type SessionMessageEntry,
  type Skill,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

import { Box, Text, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

import { Type, type Static } from "typebox";

import { renderTextContent, taskResultTextContent } from "./text-content.js";

export function toolPushTask(pi: PushTaskAPI): ToolDefinition {
  return defineTool({
    name: "push-task",
    label: "Push Task",
    description: "Store a task prompt for a user-started navigation branch.",
    promptSnippet: "Store a focused task prompt for a user-started navigation branch.",
    promptGuidelines: [
      "Use push-task to hand off a self-contained task for isolated execution.",
      "Do not batch multiple push-task calls together, and do not mix push-task with other tool calls in the same turn.",
    ],
    parameters: pushTaskParameters,
    renderCall(args: PushTaskParams, theme, context) {
      const title = args.title.trim();
      const header = theme.fg("toolTitle", theme.bold(`push-task: ${title}`));

      const promptLines = args.prompt.split("\n");
      const maxLines = context.expanded ? promptLines.length : 7;
      const displayLines = promptLines
        .slice(0, maxLines)
        .map((l) => theme.fg("dim", l.trimEnd() || " "));

      if (!context.expanded && promptLines.length > maxLines) {
        const totalLines = promptLines.length;
        const moreLines = totalLines - maxLines;
        displayLines.push(
          theme.fg("muted", `... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`),
        );
      }

      return new Text([header, ...displayLines].join("\n"), 0, 0);
    },
    renderResult() {
      return new Text("", 0, 0);
    },
    async execute(_toolCallId, params: PushTaskParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Task storage aborted.");
      }

      const title = params.title.trim();

      const { rewritten, unresolved } = resolveSkillRefs(params.prompt);

      pi.appendEntry(TASK_ENTRY_TYPE, {
        title,
        prompt: rewritten,
      });

      if (ctx.hasUI) {
        refreshTaskStatus(ctx);
        if (unresolved.length > 0) {
          const names = unresolved.map((n) => `/skill:${n}`).join(", ");
          ctx.ui.notify(
            `Warning: ${names} were not resolved.\nTask stored. Use \`/start-task\` or \`/auto\` to start it.`,
            "warning",
          );
        } else {
          ctx.ui.notify("Task stored. Use `/start-task` or `/auto` to start it.", "info");
        }
      }

      return {
        content: [],
        details: {
          title,
          prompt: rewritten,
        },
        terminate: true,
      };
    },
  });
}

export function cmdStartTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Navigate to a fresh context and inject the active task prompt",
    getArgumentCompletions: (argumentPrefix: string) => {
      if (!modelRegistry) return null;
      return getModelCompletions(argumentPrefix, modelRegistry);
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const modelArg = args.trim() || undefined;
      await startTask(pi, ctx, { modelArg });
    },
  };
}

export function cmdTaskModel(): CommandOptions {
  return {
    description: "Choose the default model for pushed tasks",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/task-model requires an interactive UI.", "warning");
        return;
      }
      const settings = readSettings(ctx);
      if (!settings) return;

      const available = ctx.modelRegistry.getAvailable();
      const models = available.map((m) => `${m.provider}/${m.id}`);
      const saved = isRecord(settings.piSupergsd)
        ? settings.piSupergsd.defaultTaskModel
        : undefined;
      const selected = await selectTaskModel(
        ctx,
        models,
        typeof saved === "string" ? saved : undefined,
      );
      if (selected === undefined) return;

      const model = available.find((m) => `${m.provider}/${m.id}` === selected);
      if (selected !== CLEAR_TASK_MODEL && !model) {
        ctx.ui.notify(`Model not available: ${selected}.`, "warning");
        return;
      }

      let thinkingLevel: TaskThinkingLevel | undefined;
      if (model) {
        const levels = getSupportedThinkingLevels(model);
        const selectedLevel = await ctx.ui.select(`Task thinking level for ${selected}`, [
          USE_PI_THINKING,
          ...levels,
        ]);
        if (selectedLevel === undefined) return;
        if (selectedLevel !== USE_PI_THINKING) {
          thinkingLevel = levels.find((level) => level === selectedLevel);
          if (!thinkingLevel) {
            ctx.ui.notify(`Thinking level not available: ${selectedLevel}.`, "warning");
            return;
          }
        }
      }

      if (!saveDefaultTaskModel(ctx, model ? selected : undefined, thinkingLevel)) return;
      ctx.ui.notify(
        model
          ? `Default task model set to ${selected}${thinkingLevel ? ` (${thinkingLevel})` : ""}.`
          : "Default task model cleared.",
        "info",
      );
    },
  };
}

export function cmdDiscardTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Discard the active task without executing it",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await discardTask(pi, ctx);
    },
  };
}

export function cmdFinishTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Finish the current task and return to the task start point",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await finishTask(pi, ctx);
    },
  };
}

export function cmdAbortTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Abort the current task without finishing",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await abortTask(pi, ctx);
    },
  };
}

export function cmdAuto(pi: AutoCommandAPI): CommandOptions {
  let running = false;
  let stopCurrentRun: (() => void) | null = null;
  let agentStartWaiter: AgentStartWaiter | null = null;

  const settleAgentStartWaiter = (started: boolean): void => {
    const waiter = agentStartWaiter;
    if (!waiter) return;

    agentStartWaiter = null;
    clearTimeout(waiter.timeout);
    waiter.resolve(started);
  };

  const waitForAgentStart = (taskStartId: string): Promise<boolean> => {
    if (agentStartWaiter) {
      throw new Error("An agent-start waiter is already active.");
    }

    return new Promise((resolve) => {
      agentStartWaiter = {
        taskStartId,
        resolve,
        timeout: setTimeout(() => settleAgentStartWaiter(false), AUTO_AGENT_START_TIMEOUT_MS),
      };
    });
  };

  pi.on("agent_start", (_event, ctx) => {
    if (agentStartWaiter && currentTask(ctx.sessionManager)?.id === agentStartWaiter.taskStartId) {
      settleAgentStartWaiter(true);
    }
  });

  pi.on("session_shutdown", async () => {
    stopCurrentRun?.();
    settleAgentStartWaiter(false);
  });

  return {
    description: "Automatically run pushed task branches",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (running) {
        ctx.ui.notify("Auto is already running.", "warning");
        return;
      }

      running = true;
      let stopped = false;
      let sawTaskActivity = false;
      stopCurrentRun = () => {
        stopped = true;
      };

      const autoStatusOptions = {
        prefix: "[auto] ",
      } satisfies TaskStatusOptions;
      refreshTaskStatus(ctx, autoStatusOptions);

      try {
        while (!stopped) {
          await ctx.waitForIdle();

          // Re-check after idle: userCtrlC/stopped may have been set
          // while we were waiting (the reaction engine runs before the
          // waiter resolves). Without this, we'd fall through to task
          // processing and might call finishTask even though the session
          // was shut down.
          if (stopped) break;

          const activeTask = currentTask(ctx.sessionManager);
          const pending = pendingTask(ctx.sessionManager);
          const lastAssistant = activeTask
            ? findLastAssistantAfterTaskStart(ctx.sessionManager, activeTask.id)
            : findLastEntry(ctx.sessionManager, isAssistantMessageEntry);
          if (
            (activeTask || pending) &&
            lastAssistant &&
            isFailedAssistantResponse(lastAssistant)
          ) {
            if (lastAssistant.message.stopReason === "error") {
              const message = activeTask
                ? "Auto stopped: the task response failed. The task was preserved for retry."
                : "Auto stopped: the latest assistant response failed. Pending tasks were preserved.";
              ctx.ui.notify(message, "error");
            }
            break;
          }

          if (pending) {
            const result = await startTask(pi, ctx, {
              statusPrefix: autoStatusOptions.prefix,
              waitForAgentStart,
            });
            if (result) break;
            sawTaskActivity = true;
            continue;
          }

          if (activeTask) {
            // Never auto-finish before the task branch has produced a response.
            if (!findLastAssistantAfterTaskStart(ctx.sessionManager, activeTask.id)) break;

            const result = await finishTask(pi, ctx, {
              statusPrefix: autoStatusOptions.prefix,
            });
            if (result === "cancelled") break;
            sawTaskActivity = true;
            continue;
          }

          // No pending tasks and no current task
          if (!sawTaskActivity) {
            // Never had any task activity — nothing to process
            ctx.ui.notify("No pending tasks to run.", "info");
            break;
          }

          if (!ctx.hasPendingMessages()) {
            break;
          }
        }
      } finally {
        settleAgentStartWaiter(false);
        stopCurrentRun = null;
        refreshTaskStatus(ctx);
        running = false;
      }
    },
  };
}

export const rendererTaskResult: MessageRenderer<{ title?: string }> = (
  message,
  _options,
  theme,
): Box => {
  const label = message.details?.title
    ? theme.fg("customMessageLabel", `${message.details.title} result:`)
    : theme.fg("customMessageLabel", "result:");
  const text = renderTextContent(message.content);
  const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
  box.addChild(new Text(`${label}\n${text}`, 0, 0));
  return box;
};

export function updateTaskStatus(
  session: ReadonlySessionLike,
  setStatus: (key: string, value: string | undefined) => void,
  theme: TaskStatusTheme,
  options: TaskStatusOptions = {},
): void {
  const prefix = options.prefix ?? "";
  const pending = pendingTask(session);
  if (pending) {
    setStatus(
      "task",
      `${prefix}${theme.fg("dim", `pending task: ${taskTitle(pending.data.title)}`)}`,
    );
    return;
  }

  const active = currentTask(session);
  if (active) {
    setStatus(
      "task",
      `${prefix}${theme.fg("dim", `current task: ${taskTitle(active.data.title)}`)}`,
    );
    return;
  }

  setStatus("task", undefined);
}

export function setSkills(s: Skill[]): void {
  skills = s;
  skillsExternallySet = true;
}

/**
 * Used by before_agent_start handler to prime the registry from Pi's
 * skill list. Does nothing if skills were already explicitly set
 * (e.g., by tests calling setSkills before h.prompt()).
 */
export function setSkillsFromEvent(s: Skill[]): void {
  if (!skillsExternallySet) {
    skills = s;
  }
}

export function setModelRegistry(mr: ModelRegistry): void {
  modelRegistry = mr;
}

const USE_PI_THINKING = "Use Pi's model thinking level";

const AUTO_AGENT_START_TIMEOUT_MS = 60_000;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

type PushTaskAPI = Pick<ExtensionAPI, "appendEntry">;

type AutoCommandAPI = TaskCommandAPI & Pick<ExtensionAPI, "on">;

type TaskStatusTheme = Pick<Theme, "fg">;

type TaskStatusOptions = {
  prefix?: string;
};

type PushTaskParams = Static<typeof pushTaskParameters>;

type TaskActionOptions = {
  statusPrefix?: string;
  modelArg?: string;
  waitForAgentStart?: (taskStartId: string) => Promise<boolean>;
};

type AgentStartWaiter = {
  taskStartId: string;
  resolve: (started: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

async function selectTaskModel(
  ctx: ExtensionCommandContext,
  models: string[],
  current: string | undefined,
): Promise<string | undefined> {
  const choices = [CLEAR_TASK_MODEL, ...models];
  if ("mode" in ctx && ctx.mode !== "tui") return ctx.ui.select("Default task model", choices);

  return ctx.ui.custom((tui, theme, keybindings, done) => {
    let index = Math.max(0, choices.indexOf(current ?? CLEAR_TASK_MODEL));
    const visible = 10;

    return {
      render(width: number) {
        const start = Math.max(
          0,
          Math.min(index - Math.floor(visible / 2), choices.length - visible),
        );
        const end = Math.min(choices.length, start + visible);
        const lines = [
          truncateToWidth(theme.fg("accent", theme.bold("Default task model")), width),
        ];
        for (let i = start; i < end; i++) {
          const label = `${i === index ? "→" : " "} ${choices[i]}`;
          lines.push(truncateToWidth(i === index ? theme.fg("accent", label) : label, width));
        }
        if (choices.length > visible) {
          lines.push(truncateToWidth(theme.fg("dim", `  (${index + 1}/${choices.length})`), width));
        }
        lines.push(
          truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"), width),
        );
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up")) {
          index = (index - 1 + choices.length) % choices.length;
        } else if (keybindings.matches(data, "tui.select.down")) {
          index = (index + 1) % choices.length;
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(choices[index]);
          return;
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
          return;
        }
        tui.requestRender();
      },
    };
  });
}

const CLEAR_TASK_MODEL = "Use current model (clear default)";

function isFailedAssistantResponse(entry: AssistantMessageEntry): boolean {
  return entry.message.stopReason === "aborted" || entry.message.stopReason === "error";
}

function findLastAssistantAfterTaskStart(
  session: ReadonlySessionLike,
  taskStartId: string,
): AssistantMessageEntry | null {
  let afterTaskStart = false;
  let lastAssistant: AssistantMessageEntry | null = null;

  for (const entry of session.getBranch()) {
    if (entry.id === taskStartId) {
      afterTaskStart = true;
      continue;
    }
    if (afterTaskStart && isAssistantMessageEntry(entry)) {
      lastAssistant = entry;
    }
  }

  return lastAssistant;
}

async function startTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  options: TaskActionOptions = {},
): Promise<TaskActionResult> {
  const activeTask = pendingTask(ctx.sessionManager);
  if (!activeTask) {
    ctx.ui.notify("No pending task. Use push-task first.", "warning");
    return;
  }

  // ── Model switching ─────────────────────────────────────────────
  const preference = options.modelArg ? { model: options.modelArg } : readDefaultTaskModel(ctx);
  if (preference === null) return "blocked";
  const { model: modelArg, thinkingLevel } = preference;
  let previousModel: TaskStartData["previousModel"];
  let previousThinkingLevel: TaskThinkingLevel | undefined;
  if (modelArg) {
    const matched = resolveModelPattern(modelArg, ctx.modelRegistry);
    if (matched === null) {
      ctx.ui.notify(`No model matching "${modelArg}".`, "warning");
      return "blocked";
    }
    if (matched === "ambiguous") {
      const names = matchModels(modelArg, ctx.modelRegistry)
        .map((m) => `${m.provider}/${m.id}`)
        .join(", ");
      ctx.ui.notify(`Ambiguous model: matches ${names}.`, "warning");
      return "blocked";
    }
    if (thinkingLevel && !getSupportedThinkingLevels(matched).includes(thinkingLevel)) {
      ctx.ui.notify(`Thinking level ${thinkingLevel} is not available for ${modelArg}.`, "warning");
      return "blocked";
    }

    const currentModel = ctx.model;
    if (currentModel) {
      previousModel = { provider: currentModel.provider, modelId: currentModel.id };
      previousThinkingLevel = pi.getThinkingLevel();
    }

    const switched = await pi.setModel(matched);
    if (!switched) {
      ctx.ui.notify(`No API key configured for ${matched.provider}/${matched.id}.`, "warning");
      return "blocked";
    }
    if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);
  }

  // ── Task start ──────────────────────────────────────────────────
  const departureLeafId = ctx.sessionManager.getLeafId()!;
  const freshTargetId = findFreshTargetId(ctx.sessionManager);
  if (!freshTargetId) {
    ctx.ui.notify("No starting point found on current branch.", "warning");
    return "blocked";
  }

  const result = await ctx.navigateTree(freshTargetId, { summarize: false });
  if (result.cancelled) return "cancelled";

  const startEntryData: TaskStartData = {
    title: taskTitle(activeTask.data.title),
    returnTo: departureLeafId,
  };
  if (previousModel) {
    startEntryData.previousModel = previousModel;
    startEntryData.previousThinkingLevel = previousThinkingLevel;
  }
  pi.appendEntry(TASK_START_ENTRY_TYPE, startEntryData);

  // The extension API returns from sendUserMessage before Pi marks the agent as active.
  // Set up the barrier first to prevent /auto from falsely detecting idle during this window.
  const taskStartId = ctx.sessionManager.getLeafId()!;
  const agentStarted = options.waitForAgentStart?.(taskStartId);
  pi.sendUserMessage(activeTask.data.prompt);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });

  if (agentStarted && !(await agentStarted)) {
    ctx.ui.notify(
      `Auto stopped: the task agent did not start within ${AUTO_AGENT_START_TIMEOUT_MS / 1000} seconds. The task was preserved.`,
      "error",
    );
    return "launch-timeout";
  }
}

/** Read the extension's persisted setting; null means a configured value could not be used. */
function readDefaultTaskModel(ctx: ExtensionCommandContext): TaskModelPreference | null {
  const settings = readSettings(ctx);
  if (!settings) return null;

  const pluginSettings = isRecord(settings.piSupergsd) ? settings.piSupergsd : {};
  const model = pluginSettings.defaultTaskModel;
  const thinkingLevel = pluginSettings.defaultTaskThinkingLevel;
  if (model === undefined && thinkingLevel === undefined) return {};
  if (typeof model !== "string" || !model.trim()) {
    ctx.ui.notify("Invalid piSupergsd.defaultTaskModel in settings.json.", "warning");
    return null;
  }
  if (thinkingLevel !== undefined && typeof thinkingLevel !== "string") {
    ctx.ui.notify("Invalid piSupergsd.defaultTaskThinkingLevel in settings.json.", "warning");
    return null;
  }
  return { model: model.trim(), thinkingLevel: thinkingLevel as TaskThinkingLevel | undefined };
}

type TaskModelPreference = { model?: string; thinkingLevel?: TaskThinkingLevel };

function saveDefaultTaskModel(
  ctx: ExtensionCommandContext,
  model: string | undefined,
  thinkingLevel: TaskThinkingLevel | undefined,
): boolean {
  const settings = readSettings(ctx);
  if (!settings) return false;

  const current = settings.piSupergsd;
  if (current !== undefined && (!isRecord(current) || Array.isArray(current))) {
    ctx.ui.notify("Invalid piSupergsd setting in settings.json.", "warning");
    return false;
  }
  const pluginSettings: Record<string, unknown> = { ...(current ?? {}) };
  if (model) pluginSettings.defaultTaskModel = model;
  else delete pluginSettings.defaultTaskModel;
  if (thinkingLevel) pluginSettings.defaultTaskThinkingLevel = thinkingLevel;
  else delete pluginSettings.defaultTaskThinkingLevel;

  if (Object.keys(pluginSettings).length > 0) settings.piSupergsd = pluginSettings;
  else delete settings.piSupergsd;

  try {
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(join(getAgentDir(), "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch (error) {
    ctx.ui.notify(`Cannot save default task model: ${String(error)}`, "warning");
    return false;
  }
}

function readSettings(ctx: ExtensionCommandContext): Record<string, unknown> | null {
  const path = join(getAgentDir(), "settings.json");
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    ctx.ui.notify(`Cannot read ${path}: ${String(error)}`, "warning");
    return null;
  }
  if (!isRecord(settings) || Array.isArray(settings)) {
    ctx.ui.notify(`Invalid ${path}: expected a JSON object.`, "warning");
    return null;
  }
  return settings;
}

async function discardTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
): Promise<TaskActionResult> {
  const activeTask = pendingTask(ctx.sessionManager);
  if (!activeTask) {
    ctx.ui.notify("No pending task to discard.", "warning");
    return;
  }

  pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
  ctx.ui.notify("Task discarded.", "info");

  refreshTaskStatus(ctx);
}

async function finishTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  options: TaskActionOptions = {},
): Promise<TaskActionResult> {
  const taskStart = currentTask(ctx.sessionManager);
  if (!taskStart) {
    ctx.ui.notify("Not inside task, nothing to finish.", "warning");
    return;
  }

  // Capture last assistant message content before navigation. Only text blocks
  // are valid for custom_message content; provider-specific thinking/tool blocks
  // must not be replayed into the parent branch.
  const lastAssistant = findLastEntry(ctx.sessionManager, isAssistantMessageEntry);
  const lastAssistantContent = lastAssistant
    ? taskResultTextContent(lastAssistant.message.content)
    : undefined;
  const lastAssistantId = lastAssistant?.id;

  const title = taskTitle(taskStart.data.title);

  const result = await ctx.navigateTree(taskStart.data.returnTo, {
    summarize: false,
  });
  if (result.cancelled) return "cancelled";

  // Inject last assistant message after navigation
  if (lastAssistantId && lastAssistantContent !== undefined) {
    pi.sendMessage(
      {
        customType: "task-result",
        // Content is filtered to only TextContent blocks (or original string)
        content: lastAssistantContent,
        display: true,
        details: { title },
      },
      { triggerTurn: true },
    );
  }

  if (pendingTask(ctx.sessionManager)) {
    pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
  }

  const label = lastAssistantId ? "Last response attached." : "No last response to attach.";
  ctx.ui.notify(`Task finished. ${label}`, "info");

  await restorePreviousModel(pi, taskStart, ctx);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });
}

async function abortTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
): Promise<TaskActionResult> {
  const taskStart = currentTask(ctx.sessionManager);
  if (!taskStart) {
    ctx.ui.notify("Not inside task, nothing to abort.", "warning");
    return;
  }

  const result = await ctx.navigateTree(taskStart.data.returnTo, {
    summarize: false,
  });
  if (result.cancelled) return "cancelled";

  ctx.ui.notify("Task aborted. Branch abandoned without summary.", "info");

  await restorePreviousModel(pi, taskStart, ctx);

  refreshTaskStatus(ctx);
}

type TaskActionResult = "blocked" | "cancelled" | "launch-timeout" | void;

/** Restore the model that was active before a task started, if one was recorded. */
async function restorePreviousModel(
  pi: TaskCommandAPI,
  taskStart: TaskStartEntry,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!taskStart.data.previousModel) return;

  const { provider, modelId } = taskStart.data.previousModel;
  const restoredModel = ctx.modelRegistry.find(provider, modelId);
  if (restoredModel) {
    if (!(await pi.setModel(restoredModel))) {
      ctx.ui.notify(`Failed to restore previous model ${provider}/${modelId}.`, "warning");
    } else if (taskStart.data.previousThinkingLevel) {
      pi.setThinkingLevel(taskStart.data.previousThinkingLevel);
    }
  } else {
    ctx.ui.notify(`Previous model ${provider}/${modelId} no longer available.`, "warning");
  }
}

type TaskCommandAPI = Pick<
  ExtensionAPI,
  | "appendEntry"
  | "sendMessage"
  | "sendUserMessage"
  | "setModel"
  | "getThinkingLevel"
  | "setThinkingLevel"
>;

function refreshTaskStatus(ctx: TaskStatusContext, options: TaskStatusOptions = {}): void {
  if (ctx.hasUI) {
    updateTaskStatus(ctx.sessionManager, ctx.ui.setStatus.bind(ctx.ui), ctx.ui.theme, options);
  }
}

type TaskStatusContext = Pick<ExtensionCommandContext, "hasUI" | "sessionManager" | "ui">;

/** Type guard: is the entry an assistant message with content? */
function isAssistantMessageEntry(entry: SessionEntry): entry is AssistantMessageEntry {
  return entry.type === "message" && entry.message.role === "assistant";
}

type AssistantMessageEntry = SessionMessageEntry & { message: { role: "assistant" } };

/**
 * Find the target ID for navigating to a fresh context.
 * Returns the parent of the first model-visible entry, or the branch root as fallback.
 * Returns null if no valid target is found.
 */
function findFreshTargetId(session: ReadonlySessionLike): string | null {
  const branch = session.getBranch();
  if (branch.length === 0) return null;

  const firstVisible = findPreConversationEntry(session);
  if (firstVisible) {
    return firstVisible.parentId ?? firstVisible.id;
  }

  // Fallback: use branch root's parent (or the root itself if no parent)
  return branch[0].parentId ?? branch[0].id;
}

/**
 * Find the first model-visible entry on the current branch (closest to root).
 *
 * "Model-visible" means the entry participates in LLM context via buildSessionContext:
 * messages (user/assistant), compaction summaries, branch summaries, and custom messages.
 * Entries like thinking_level_change, model_change, custom (data-only), label, and
 * session_info are NOT visible — Pi may insert them before the conversation begins.
 *
 * Returns null if the branch has no model-visible entries (e.g., only non-visible setup
 * entries) or if there is no leaf.
 */
function findPreConversationEntry(session: ReadonlySessionLike): SessionEntry | null {
  if (!session.getLeafId()) return null;

  const branch = session.getBranch();
  for (const entry of branch) {
    if (
      entry.type === "message" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary" ||
      entry.type === "custom_message"
    ) {
      return entry;
    }
  }

  return null;
}

// ── Lookup utilities ──────────────────────────────────────────────

function pendingTask(session: ReadonlySessionLike): TaskEntry | null {
  const branch = session.getBranch();
  let skip = 0;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === TASK_START_ENTRY_TYPE) {
      return null;
    }
    if (entry.type === "custom" && entry.customType === TASK_DONE_ENTRY_TYPE) {
      skip++;
      continue;
    }
    if (isTaskEntry(entry)) {
      if (skip === 0) return entry;
      skip--;
    }
  }

  return null;
}

const TASK_DONE_ENTRY_TYPE = "task-done";

function currentTask(session: ReadonlySessionLike): TaskStartEntry | null {
  return findLastEntry(session, isTaskStartEntry) ?? null;
}

function findLastEntry<T extends SessionEntry>(
  session: ReadonlySessionLike,
  predicate: (entry: SessionEntry) => entry is T,
): T | undefined {
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (predicate(entry)) return entry;
  }
  return undefined;
}

/**
 * Minimal read-only session interface needed by lookup functions.
 * Compatible with both ReadonlySessionManager (from ExtensionCommandContext)
 * and SessionManager (full mutable version).
 */
interface ReadonlySessionLike {
  getLeafId(): string | null;
  getBranch(): SessionEntry[];
}

function isTaskEntry(entry: SessionEntry): entry is TaskEntry {
  return isCustomEntry(entry, TASK_ENTRY_TYPE, isTaskData);
}

type TaskEntry = CustomEntry<typeof TASK_ENTRY_TYPE, TaskData>;

const TASK_ENTRY_TYPE = "task";

function isTaskData(value: unknown): value is TaskData {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    (value.title === undefined || typeof value.title === "string")
  );
}

interface TaskData {
  title?: string;
  prompt: string;
}

function isTaskStartEntry(entry: SessionEntry): entry is TaskStartEntry {
  return isCustomEntry(entry, TASK_START_ENTRY_TYPE, isTaskStartData);
}

type TaskStartEntry = CustomEntry<typeof TASK_START_ENTRY_TYPE, TaskStartData>;

const TASK_START_ENTRY_TYPE = "task-start";

function isCustomEntry<TCustomType extends string, TData>(
  entry: SessionEntry,
  customType: TCustomType,
  isData: (value: unknown) => value is TData,
): entry is CustomEntry<TCustomType, TData> {
  return entry.type === "custom" && entry.customType === customType && isData(entry.data);
}

type CustomEntry<TCustomType extends string, TData> = SessionEntry & {
  type: "custom";
  customType: TCustomType;
  data: TData;
};

function isTaskStartData(value: unknown): value is TaskStartData {
  if (
    !isRecord(value) ||
    typeof value.returnTo !== "string" ||
    (value.title !== undefined && typeof value.title !== "string")
  ) {
    return false;
  }
  if (
    value.previousThinkingLevel !== undefined &&
    typeof value.previousThinkingLevel !== "string"
  ) {
    return false;
  }
  if (value.previousModel !== undefined) {
    return (
      isRecord(value.previousModel) &&
      typeof value.previousModel.provider === "string" &&
      typeof value.previousModel.modelId === "string"
    );
  }
  return true;
}

interface TaskStartData {
  title?: string;
  returnTo: string;
  previousModel?: { provider: string; modelId: string };
  previousThinkingLevel?: TaskThinkingLevel;
}

type TaskThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize an optional title to a non-empty display string. */
function taskTitle(title?: string): string {
  return title || "untitled";
}

function resolveSkillRefs(prompt: string): ResolveResult {
  const unresolvedSet = new Set<string>();
  const byName = new Map<string, string>();
  for (const skill of skills) {
    byName.set(skill.name, skill.filePath);
  }

  const rewritten = prompt.replace(
    /\/skill:([a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9])/g,
    (match, name) => {
      const filePath = byName.get(name);
      if (filePath) {
        return filePath;
      }
      unresolvedSet.add(name);
      return match;
    },
  );

  return { rewritten, unresolved: [...unresolvedSet] };
}

interface ResolveResult {
  rewritten: string;
  unresolved: string[];
}

/**
 * Resolve a model pattern to a single model, null (no match), or "ambiguous".
 *
 * Matching order:
 * 1. If pattern contains "/": split as provider/modelId, try exact lookup.
 *    Falls through to substring matching even if the exact lookup fails.
 * 2. Substring, case-insensitive match against each available model's
 *    id, name, and provider/id.
 */
function resolveModelPattern(
  pattern: string,
  registry: ModelRegistry,
): Model<Api> | "ambiguous" | null {
  if (pattern.includes("/")) {
    const slashIdx = pattern.indexOf("/");
    const found = registry.find(pattern.slice(0, slashIdx), pattern.slice(slashIdx + 1));
    if (found) return found;
  }

  const matches = matchModels(pattern, registry);
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

/**
 * Autocompletion for /start-task model argument, mirroring the /model
 * command: label is the model id, description is the provider, and value
 * is provider/id (what gets typed and resolved). Returns up to 20 items.
 */
function getModelCompletions(argumentPrefix: string, registry: ModelRegistry): AutocompleteItem[] {
  return matchModels(argumentPrefix, registry)
    .slice(0, 20)
    .map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: m.id,
      description: m.provider,
    }));
}

/** Case-insensitive substring match of `pattern` against each available model's id, name, or provider/id. */
function matchModels(pattern: string, registry: ModelRegistry): Model<Api>[] {
  const lower = pattern.toLowerCase();
  return registry
    .getAvailable()
    .filter(
      (m) =>
        m.id.toLowerCase().includes(lower) ||
        m.name.toLowerCase().includes(lower) ||
        `${m.provider}/${m.id}`.toLowerCase().includes(lower),
    );
}

const pushTaskParameters = Type.Object({
  title: Type.String({
    description: "Short task title shown in status, results, and tool rendering.",
  }),
  prompt: Type.String({
    description: "Full prompt for the task, including all context and instructions.",
  }),
});

// ── Skill resolution registry ─────────────────────────────────────

let skills: Skill[] = [];

let skillsExternallySet = false;

let modelRegistry: ModelRegistry | undefined;
