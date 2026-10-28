import {
  DEFAULT_AGENT_MAX_ITERATIONS,
  DEFAULT_BASE_URLS,
  DEFAULT_LOCAL_OPENAI_BASE_URL,
  MAX_AGENT_ITERATIONS,
} from "@codent/core";
import { Box, Text } from "ink";
import { useEffect } from "react";

import { useAdapter } from "../context/adapter-context.js";
import { useCoreEnv } from "../context/core-env-context.js";
import { useConfig } from "../hooks/use-config.js";
import { COLORS } from "../theme/colors.js";
import { getKeyboardShortcutSections } from "../utils/keyboard-labels.js";

/** Give Ink one frame to paint the help text before the process goes away. */
const HELP_EXIT_DELAY_MS = 150;

export const Help = () => {
  const config = useConfig((s) => s.config);
  const adapter = useAdapter();
  const env = useCoreEnv();
  const shortcutSections = getKeyboardShortcutSections();
  // Cosmetic host identity. `productName` is the host's own name (`codent` for
  // the bundled release host, `@codent/cli` for the development host), and
  // `remotePlanes: false` hides the remote WORKSPACE flags a host cannot honour
  // (`--remote-env` / `--remote-session`; `--remote-provider` is core and always available).
  const name = config.productName || "codent";
  const remotePlanes = config.remotePlanes !== false;
  // `bootstrapCliHost` sets this because the shared CLI shell owns the `codent acp` intercept.
  const acp = config.acp === true;

  // `--help` used to render and then hang: nothing in this branch ever ended the
  // process, and by the time it mounted the CoreEnv, the OS sandbox and the Ink
  // render loop were all live, so it waited on stdin forever. Deferred by a
  // frame so the text reaches the terminal before stdout is torn down.
  useEffect(() => {
    const timer = setTimeout(() => adapter.exit(), HELP_EXIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [adapter]);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>
          {name}
        </Text>
        <Text> - AI-powered coding assistant</Text>
      </Box>

      {/* Usage */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.warning}>
          USAGE
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>{name} [options] [prompt]</Text>
          {acp && <Text>{name} acp - serve the agent over ACP on stdio (for editors / ACP clients)</Text>}
          <Text>{name} -h, --help</Text>
        </Box>
      </Box>

      {/* Options */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.warning}>
          OPTIONS
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>-m, --model</Text>
            </Box>
            <Text>Model name (required — set via MODEL env or --model)</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>--style</Text>
            </Box>
            <Text>API style: openai | anthropic (default: openai)</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>-u, --url</Text>
            </Box>
            <Text>Base URL alias for --base-url (OpenAI-compatible default: {DEFAULT_LOCAL_OPENAI_BASE_URL})</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>--base-url</Text>
            </Box>
            <Text>API base URL (defaults per style when unset)</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>-k, --api-key</Text>
            </Box>
            <Text>API key (required for anthropic style)</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>--max-iterations</Text>
            </Box>
            <Text>{`Max agent loop iterations (default: ${DEFAULT_AGENT_MAX_ITERATIONS}, max: ${MAX_AGENT_ITERATIONS})`}</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>--max-concurrent-tasks</Text>
            </Box>
            <Text>Max concurrent task subagents (default: 4)</Text>
          </Box>
          {remotePlanes && (
            <>
              <Box>
                <Box width={24}>
                  <Text color={COLORS.success}>-R, --remote-env</Text>
                </Box>
                <Text>Remote CoreEnv server URL (workspace)</Text>
              </Box>
              <Box>
                <Box width={24}>
                  <Text color={COLORS.success}>--remote-session</Text>
                </Box>
                <Text>Remote Agent Session URL (orthogonal to --remote-env)</Text>
              </Box>
            </>
          )}
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>--remote-provider</Text>
            </Box>
            <Text>Remote LLM provider URL (workspace-independent)</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>-h, --help</Text>
            </Box>
            <Text>Show this help message</Text>
          </Box>
          <Box>
            <Box width={24}>
              <Text color={COLORS.success}>-v, --version</Text>
            </Box>
            <Text>Print version and exit</Text>
          </Box>
        </Box>
      </Box>

      {/* Environment Variables */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.warning}>
          ENVIRONMENT (.env)
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={COLORS.muted}>Create a .env file in your project root:</Text>
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            <Text color={COLORS.primary}>MODEL_STYLE=openai</Text>
            <Text color={COLORS.primary}>MODEL=anthropic/claude-3.5-sonnet</Text>
            <Text color={COLORS.primary}>BASE_URL=https://openrouter.ai/api/v1</Text>
            <Text color={COLORS.primary}>API_KEY=sk-or-v1-xxx</Text>
            <Text color={COLORS.primary}>MAX_ITERATIONS=30</Text>
            <Text color={COLORS.primary}>REMOTE_PROVIDER=http://localhost:3100</Text>
            {remotePlanes && (
              <>
                <Text color={COLORS.primary}>REMOTE_ENV=http://localhost:3100</Text>
                <Text color={COLORS.primary}>REMOTE_SESSION=http://localhost:3100</Text>
              </>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.muted}>
              Priority: CLI args {">"} env vars {">"} defaults
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Current Config */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.warning}>
          CURRENT CONFIG
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Box width={14}>
              <Text color={COLORS.primary}>style:</Text>
            </Box>
            <Text>{config.style}</Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text color={COLORS.primary}>model:</Text>
            </Box>
            <Text>{config.serverModel || config.model}</Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text color={COLORS.primary}>baseURL:</Text>
            </Box>
            <Text>{config.baseURL || DEFAULT_BASE_URLS[config.style]}</Text>
          </Box>
          {config.providerMode === "remote" ? (
            <Box>
              <Box width={14}>
                <Text color={COLORS.primary}>provider:</Text>
              </Box>
              <Text>remote (keys on provider server)</Text>
            </Box>
          ) : (
            config.apiKey && (
              <Box>
                <Box width={14}>
                  <Text color={COLORS.primary}>apiKey:</Text>
                </Box>
                <Text>{`${config.apiKey.slice(0, 12)}...`}</Text>
              </Box>
            )
          )}
          <Box>
            <Box width={14}>
              <Text color={COLORS.primary}>path:</Text>
            </Box>
            <Text>{env.rootPath}</Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text color={COLORS.primary}>maxIterations:</Text>
            </Box>
            <Text>{config.maxIterations}</Text>
          </Box>
        </Box>
      </Box>

      {/* Examples */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.warning}>
          EXAMPLES
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={COLORS.muted}>{`$ ${name} "Create a hello world function"`}</Text>
          <Text color={COLORS.muted}>
            {`$ ${name} --style openai --base-url https://openrouter.ai/api/v1 -m anthropic/claude-3.5-sonnet -k sk-or-... "Review code"`}
          </Text>
          {remotePlanes && (
            <Text color={COLORS.muted}>
              {`$ ${name} --remote-env http://localhost:3100 --remote-provider http://localhost:3100 "Fix the bug"`}
            </Text>
          )}
        </Box>
      </Box>

      {/* Keyboard */}
      <Box flexDirection="column">
        <Text bold color={COLORS.warning}>
          KEYBOARD
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          {shortcutSections.map((section) => (
            <Box key={section.title} flexDirection="column" marginBottom={1}>
              <Text bold color={COLORS.primary}>
                {section.title}
              </Text>
              {section.lines.map((row) => (
                <Box key={row.key}>
                  <Box width={28}>
                    <Text color={COLORS.success}>{row.key}</Text>
                  </Box>
                  <Text>{row.desc}</Text>
                </Box>
              ))}
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color={COLORS.muted}>Tip: type /help to see all commands and keyboard shortcuts.</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
