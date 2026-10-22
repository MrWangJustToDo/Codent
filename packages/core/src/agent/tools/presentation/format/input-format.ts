import { truncateText } from "../../../../utils/text-truncation.js";
import { BUILTIN_TOOL_NAMES } from "../../catalog/tool-names.js";

import { ENTRY_VALUE_MAX_CHARS } from "./format.js";

function formatFilePathInput(input: Record<string, unknown>, toolName?: string): string {
  const path = input.path as string | undefined;
  if (!path) return "";

  if (toolName === BUILTIN_TOOL_NAMES.readFile && (input.offset !== undefined || input.limit !== undefined)) {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;

    if (offset !== undefined && limit !== undefined) {
      return `${path} lines ${offset}-${offset + limit - 1}`;
    }
    if (offset !== undefined) {
      return `${path} from line ${offset}`;
    }
    if (limit !== undefined) {
      return `${path} first ${limit} lines`;
    }
  }

  return path;
}

function formatRunCommandInput(input: Record<string, unknown>, compact = false): string {
  const command = input.command as string | undefined;
  if (compact) {
    const cmd = command ?? "";
    return `$ ${truncateText(cmd, 56)}`;
  }
  let res = "$";
  res += ` ${command ?? ""}`;
  if (input.cwd) {
    res += ` (cwd: ${input.cwd})`;
  }
  if (input.timeout) {
    res += ` (timeout: ${input.timeout}ms)`;
  }
  if (input.run_in_background) {
    res += ` (background: true)`;
  }
  return res;
}

function formatGrepInput(input: Record<string, unknown>): string {
  const pattern = input.pattern as string | undefined;
  if (!pattern) return "";
  const parts: string[] = [JSON.stringify(pattern)];
  if (input.path) parts.push(`in ${input.path}`);
  if (input.include) parts.push(`--include=${input.include}`);
  return parts.join(" ");
}

function formatGlobInput(input: Record<string, unknown>): string {
  const pattern = input.pattern as string | undefined;
  if (!pattern) return "";
  const parts: string[] = [JSON.stringify(pattern)];
  if (input.path) parts.push(`in ${input.path}`);
  return parts.join(" ");
}

function formatTaskInput(input: Record<string, unknown>): string {
  const description = input.description as string | undefined;
  const prompt = input.prompt as string | undefined;
  if (description) return description;
  if (prompt) {
    return truncateText(prompt, 60);
  }
  return "";
}

function formatTodoInput(input: Record<string, unknown>): string {
  const title = input.title as string | undefined;
  return title ?? "";
}

function formatWebSearchInput(input: Record<string, unknown>): string {
  const query = input.query as string | undefined;
  return query ? JSON.stringify(query) : "";
}

function formatWebFetchInput(input: Record<string, unknown>): string {
  const url = input.url as string | undefined;
  return url ?? "";
}

function formatTreeInput(input: Record<string, unknown>): string {
  const path = (input.path as string) ?? ".";
  const parts: string[] = [path];
  if (input.maxDepth !== undefined) parts.push(`depth=${input.maxDepth}`);
  if (input.pattern) parts.push(`pattern=${input.pattern}`);
  return parts.join(" ");
}

function formatLoadSkillInput(input: Record<string, unknown>): string {
  const name = input.name as string | undefined;
  return name ?? "";
}

function formatGenericInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncateText(input, ENTRY_VALUE_MAX_CHARS);

  const obj = input as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";

  const formatted = entries
    .slice(0, 2)
    .map(([key, value]) => {
      const strValue = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${truncateText(strValue, ENTRY_VALUE_MAX_CHARS)}`;
    })
    .join(", ");

  return entries.length > 2 ? `(${formatted}, ...)` : `(${formatted})`;
}

function formatAskUserInput(input: Record<string, unknown>): string {
  const question = input.question as string | undefined;
  return question ?? "";
}

function formatCreatePlanInput(input: Record<string, unknown>): string {
  const goal = typeof input.goal === "string" ? input.goal : "";
  const steps = Array.isArray(input.steps) ? input.steps.length : 0;
  if (!goal) return steps > 0 ? `${steps} steps` : "";
  const short = truncateText(goal, 60);
  return steps > 0 ? `${short} (${steps} steps)` : short;
}

/** Format tool input for display based on tool name. */
export function formatToolInput(
  input: unknown,
  toolName?: string,
  options?: { compact?: boolean; maxLen?: number }
): string {
  if (input === undefined || input === null) return "";

  const compact = options?.compact === true;
  const maxLen = options?.maxLen ?? (compact ? 72 : undefined);

  let formatted = "";
  if (toolName && typeof input === "object") {
    const obj = input as Record<string, unknown>;

    switch (toolName) {
      case BUILTIN_TOOL_NAMES.readFile:
        formatted = formatFilePathInput(obj, toolName);
        break;
      case BUILTIN_TOOL_NAMES.listFile:
      case BUILTIN_TOOL_NAMES.writeFile:
      case BUILTIN_TOOL_NAMES.editFile:
      case BUILTIN_TOOL_NAMES.deleteFile:
        formatted = formatFilePathInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.runCommand:
        formatted = formatRunCommandInput(obj, compact);
        break;
      case BUILTIN_TOOL_NAMES.grep:
        formatted = formatGrepInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.glob:
        formatted = formatGlobInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.task:
        formatted = formatTaskInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.todo:
        formatted = formatTodoInput(obj);
        break;
      case "web_search":
      case BUILTIN_TOOL_NAMES.websearch:
        formatted = formatWebSearchInput(obj);
        break;
      case "web_fetch":
      case BUILTIN_TOOL_NAMES.webfetch:
        formatted = formatWebFetchInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.tree:
        formatted = formatTreeInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.loadSkill:
        formatted = formatLoadSkillInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.askUser:
        formatted = formatAskUserInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.createPlan:
      case BUILTIN_TOOL_NAMES.updatePlan:
        formatted = formatCreatePlanInput(obj);
        break;
      case BUILTIN_TOOL_NAMES.listSkills:
        formatted = "";
        break;
      default:
        formatted = formatGenericInput(input);
        break;
    }
  } else {
    formatted = formatGenericInput(input);
  }

  if (maxLen != null) {
    return truncateText(formatted, maxLen);
  }
  return formatted;
}
