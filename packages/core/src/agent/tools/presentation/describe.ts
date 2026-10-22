import { getBuiltinToolPresentation, builtinPresentationNames } from "./builtin.js";

import type { ToolPresentation, ToolPresentationInfo, ToolPresentationResolver } from "./types.js";

/** Serializable projection of a descriptor (functions dropped) for host consumption. */
export function describePresentation(name: string, present: ToolPresentation | undefined): ToolPresentationInfo {
  return {
    name,
    category: present?.category,
    keepRow: present?.keepRow,
    detailed: present?.detailed,
    clientSide: present?.clientSide,
    hasText: present?.text !== undefined,
    hasSummary: present?.summary !== undefined,
    labelKey: present?.labelKey,
  };
}

/** Rehydrate a host-side descriptor. Renderers cannot cross processes; presence stubs are enough. */
export function presentationFromInfo(info: ToolPresentationInfo): ToolPresentation {
  const present: ToolPresentation = {};
  if (info.category) present.category = info.category;
  if (info.keepRow) present.keepRow = true;
  if (info.detailed) present.detailed = true;
  if (info.clientSide) present.clientSide = true;
  if (info.labelKey) present.labelKey = info.labelKey;
  if (info.hasText) present.text = () => undefined;
  return present;
}

/** Serializable catalog for hosts; defaults to the static built-in table. */
export function describeToolPresentations(
  names: Iterable<string> = builtinPresentationNames(),
  resolve: ToolPresentationResolver = getBuiltinToolPresentation
): ToolPresentationInfo[] {
  return [...names].map((name) => describePresentation(name, resolve(name)));
}
