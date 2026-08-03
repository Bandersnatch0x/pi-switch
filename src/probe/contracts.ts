/**
 * Probe Contract builders — named, isolated, minimal, repeatable.
 * Never include session history or user-supplied prompts.
 */

import type {
  ProbeCompleteOptions,
  ProbeContext,
  ProbeContractId,
  ProbeToolDef,
} from "./types.ts";

/** Side-effect-free tool used only for the tool contract. */
export const PROBE_ECHO_TOOL: ProbeToolDef = {
  name: "probe_echo",
  description:
    "Echo a short message for compatibility probing. No side effects.",
  parameters: {
    type: "object",
    properties: {
      msg: { type: "string", description: "Short echo payload" },
    },
    required: ["msg"],
  },
};

const BASIC_PROMPT =
  "probe_basic: reply with exactly probe_ok and nothing else";
const REASONING_PROMPT =
  "probe_reasoning: think briefly then reply with exactly probe_ok";
const TOOL_PROMPT =
  "probe_tool: call the probe_echo tool with msg set to probe_ok";

export interface BuiltContract {
  contract: ProbeContractId;
  context: ProbeContext;
  /** Extra complete options beyond maxTokens/signal. */
  optionExtras: Pick<ProbeCompleteOptions, "reasoning">;
}

/** Build the synthetic context + option extras for one Probe Contract. */
export function buildContractRequest(
  contract: ProbeContractId,
  timestamp: number,
): BuiltContract {
  const user = (content: string) =>
    ({ role: "user" as const, content, timestamp });

  switch (contract) {
    case "basic":
      return {
        contract,
        context: { messages: [user(BASIC_PROMPT)] },
        optionExtras: {},
      };
    case "reasoning":
      return {
        contract,
        context: { messages: [user(REASONING_PROMPT)] },
        optionExtras: { reasoning: "low" },
      };
    case "tool":
      return {
        contract,
        context: {
          messages: [user(TOOL_PROMPT)],
          tools: [PROBE_ECHO_TOOL],
        },
        optionExtras: {},
      };
  }
}
