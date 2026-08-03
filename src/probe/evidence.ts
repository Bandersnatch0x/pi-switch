/**
 * Minimal evidence classification for the probe engine (ticket 1).
 * Ticket 2 expands normalization, redaction, and Repair Case persistence.
 */

import type {
  ProbeAssistantMessage,
  ProbeContractId,
  ProbeFailureCategory,
  ProbeTransportResult,
} from "./types.ts";

export interface ClassifiedFailure {
  category: ProbeFailureCategory;
  unrepairable: boolean;
  /** Hard stop for the whole run (401/429/5xx). */
  hardStop: boolean;
  summary: string;
}

/**
 * Classify HTTP status for stop / unrepairable decisions.
 * Spec: 401/429/5xx → unrepairable, stop immediately.
 */
export function classifyHttpStatus(status: number): ClassifiedFailure | undefined {
  if (status === 401 || status === 403) {
    return {
      category: "auth",
      unrepairable: true,
      hardStop: true,
      summary: `HTTP ${status}: authentication or authorization failed`,
    };
  }
  if (status === 429) {
    return {
      category: "auth",
      unrepairable: true,
      hardStop: true,
      summary: "HTTP 429: rate limited",
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      category: "protocol",
      unrepairable: true,
      hardStop: true,
      summary: `HTTP ${status}: upstream server error`,
    };
  }
  if (status === 404) {
    return {
      category: "model",
      unrepairable: false,
      hardStop: false,
      summary: "HTTP 404: model or endpoint not found",
    };
  }
  if (status >= 400 && status <= 499) {
    return {
      category: "unknown",
      unrepairable: false,
      hardStop: false,
      summary: `HTTP ${status}: client error`,
    };
  }
  return undefined;
}

function hasText(message: ProbeAssistantMessage): boolean {
  return message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

function hasThinking(message: ProbeAssistantMessage): boolean {
  return message.content.some(
    (b) => b.type === "thinking" && b.thinking.trim().length > 0,
  );
}

function hasProbeEchoToolCall(message: ProbeAssistantMessage): boolean {
  return message.content.some(
    (b) => b.type === "toolCall" && b.name === "probe_echo",
  );
}

export type ContractEval =
  | { ok: true; summary: string }
  | { ok: false; category: ProbeFailureCategory; summary: string };

/**
 * Evaluate whether a transport result satisfies the Probe Contract.
 * Ambiguous outcomes stay category "unknown" (no guessing).
 */
export function evaluateContract(
  contract: ProbeContractId,
  result: ProbeTransportResult,
): ContractEval {
  const { message, httpStatus } = result;

  if (httpStatus !== undefined && httpStatus >= 400) {
    const classified = classifyHttpStatus(httpStatus);
    if (classified) {
      return {
        ok: false,
        category: classified.category,
        summary: classified.summary,
      };
    }
  }

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      ok: false,
      category: "unknown",
      summary:
        message.errorMessage?.trim() ||
        `provider returned stopReason=${message.stopReason}`,
    };
  }

  switch (contract) {
    case "basic":
      if (hasText(message)) {
        return { ok: true, summary: "basic text response received" };
      }
      return {
        ok: false,
        category: "protocol",
        summary: "basic contract: no text content in assistant response",
      };

    case "reasoning":
      // Controlled reasoning: request was sent with reasoning option.
      // Pass when the call completes without error. Thinking block is preferred
      // but not required (some relays strip thinking while accepting the param).
      if (message.stopReason === "stop" || message.stopReason === "length") {
        if (hasThinking(message) || hasText(message)) {
          return {
            ok: true,
            summary: hasThinking(message)
              ? "reasoning response includes thinking"
              : "reasoning request completed without error",
          };
        }
      }
      return {
        ok: false,
        category: "protocol",
        summary: "reasoning contract: empty or unexpected response",
      };

    case "tool":
      if (message.stopReason === "toolUse" && hasProbeEchoToolCall(message)) {
        return { ok: true, summary: "probe_echo tool call received" };
      }
      if (hasProbeEchoToolCall(message)) {
        return { ok: true, summary: "probe_echo tool call received" };
      }
      return {
        ok: false,
        category: "tool",
        summary: "tool contract: expected probe_echo tool call",
      };
  }
}

/**
 * Map a failed contract evaluation + HTTP status into a full ClassifiedFailure
 * (adds hardStop / unrepairable for 401/429/5xx).
 */
export function classifyStageFailure(
  evalResult: Extract<ContractEval, { ok: false }>,
  httpStatus?: number,
): ClassifiedFailure {
  if (httpStatus !== undefined) {
    const fromHttp = classifyHttpStatus(httpStatus);
    if (fromHttp) return fromHttp;
  }
  return {
    category: evalResult.category,
    unrepairable: false,
    hardStop: false,
    summary: evalResult.summary,
  };
}
