import { CodeView, type CodeViewRef, type ScrollState } from "@git-diff-view/cli";
import { Box, Text } from "ink";
import { forwardRef, useEffect, useMemo, useState } from "react";

import { useCoreEnv } from "../context/core-env-context.js";
import { useDiffHighlighter } from "../hooks/use-diff-highlighter.js";
import { COLORS } from "../theme/colors.js";
import { isLikelyBinaryPath } from "../utils/file-icons.js";

import type { CoreEnv } from "@codent/core";

// ============================================================================
// File content cache
// ============================================================================

const contentCache = new Map<string, Promise<string>>();

function fetchFileContent(env: CoreEnv, path: string): Promise<string> {
  const cached = contentCache.get(path);
  if (cached) return cached;

  const promise = env.fs.readFile(path).catch((error: unknown) => {
    contentCache.delete(path);
    throw error;
  });

  contentCache.set(path, promise);
  return promise;
}

export function clearContentCache(): void {
  contentCache.clear();
}

const MAX_PREVIEW_CHARS = 120_000;

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string; truncated: boolean; totalLines: number };

// ============================================================================
// FileContent
// ============================================================================

interface FileContentProps {
  filePath: string;
  width: number;
  /** Viewport height in terminal rows, including the file header line. */
  height?: number;
  onScrollChange?: (state: ScrollState) => void;
}

export const FileContent = forwardRef<CodeViewRef, FileContentProps>(function FileContent(
  { filePath, width, height, onScrollChange },
  ref
) {
  const env = useCoreEnv();
  const highlighter = useDiffHighlighter();
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [scrollState, setScrollState] = useState<ScrollState | null>(null);
  const fileName = useMemo(() => filePath.split("/").pop() || filePath, [filePath]);
  const fileLanguage = useMemo(() => {
    const extension = filePath.split(".").pop();
    return extension ? extension.toLowerCase() : undefined;
  }, [filePath]);
  const codeHeight = height ? Math.max(1, height - 1) : undefined;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setScrollState(null);

    if (isLikelyBinaryPath(filePath)) {
      setState({ status: "error", message: "Binary file — preview not available in workspace." });
      return;
    }

    fetchFileContent(env, filePath)
      .then((raw) => {
        if (cancelled) return;
        const totalLines = raw.length === 0 ? 0 : raw.split("\n").length;
        let content = raw;
        let truncated = false;

        if (raw.length > MAX_PREVIEW_CHARS) {
          content = raw.slice(0, MAX_PREVIEW_CHARS);
          truncated = true;
        }

        setState({ status: "ready", content, truncated, totalLines });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to read file";
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [env, filePath]);

  const handleScrollChange = (next: ScrollState) => {
    setScrollState(next);
    onScrollChange?.(next);
  };

  if (state.status === "loading") {
    return (
      <Box paddingY={1}>
        <Text color={COLORS.muted}>Loading file...</Text>
      </Box>
    );
  }

  if (state.status === "error") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color={COLORS.danger}>
          Cannot preview
        </Text>
        <Text color={COLORS.danger}>{state.message}</Text>
      </Box>
    );
  }

  if (state.content.length === 0) {
    return (
      <Box paddingY={1}>
        <Text color={COLORS.muted} dimColor>
          (empty file)
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0} paddingY={0} borderBottom>
        <Text bold color={COLORS.primary}>
          {fileName}
        </Text>
        <Text color={COLORS.muted} dimColor>
          {" "}
          — {state.totalLines} line{state.totalLines === 1 ? "" : "s"}
          {state.truncated ? " (preview truncated)" : ""}
          {scrollState && scrollState.startLine > 1 ? ` · L${scrollState.startLine}+` : ""}
        </Text>
      </Box>

      <Box flexShrink={0} paddingY={0}>
        <CodeView
          ref={ref}
          key={filePath}
          data={{ content: state.content, fileName, fileLang: fileLanguage }}
          width={width}
          height={codeHeight}
          codeViewTheme="dark"
          codeViewHighlight
          {...(highlighter ? { registerHighlighter: highlighter } : {})}
          codeViewNoBG
          onScrollChange={handleScrollChange}
        />
      </Box>
    </Box>
  );
});
