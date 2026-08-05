export type StrictRelayProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type StrictRelayRule = "not_allowed" | "required" | "forbidden";

export interface StrictRelayProfile {
  name: string;
  /** Allowed top-level request fields. Nested shape is pinned by exact-body fixtures. */
  allowedFields: readonly string[];
  /** Required field paths. Array segments use `[]`, for example `tools[].function.name`. */
  requiredFields?: readonly string[];
  /** Forbidden field paths. Array segments use `[]`, for example `tools[].function.strict`. */
  forbiddenFields?: readonly string[];
}

export interface StrictRelayRequest {
  method: string;
  pathname: string;
  body: Record<string, unknown>;
}

export interface StrictRelayRejection {
  status: 400;
  field: string;
  rule: StrictRelayRule;
}

export interface StrictRelay {
  origin: string;
  baseUrl: string;
  endpointUrl: string;
  requests: StrictRelayRequest[];
  rejections: StrictRelayRejection[];
  close(): void;
}

interface FieldErrorBody {
  error: {
    type: "strict_relay_field_error";
    field: string;
    rule: StrictRelayRule;
    message: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFieldPath(body: Record<string, unknown>, fieldPath: string): boolean {
  let values: unknown[] = [body];

  for (const rawSegment of fieldPath.split(".")) {
    const arraySegment = rawSegment.endsWith("[]");
    const segment = arraySegment ? rawSegment.slice(0, -2) : rawSegment;
    const next: unknown[] = [];

    for (const value of values) {
      if (!isRecord(value) || !Object.hasOwn(value, segment)) continue;
      const child = value[segment];
      if (arraySegment) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }

    if (next.length === 0) return false;
    values = next;
  }

  return values.length > 0;
}

function validateBody(
  body: Record<string, unknown>,
  profile: StrictRelayProfile,
): { field: string; rule: StrictRelayRule } | undefined {
  const allowed = new Set(profile.allowedFields);
  const unexpected = Object.keys(body).find((field) => !allowed.has(field));
  if (unexpected) return { field: unexpected, rule: "not_allowed" };

  const missing = profile.requiredFields?.find(
    (field) => !hasFieldPath(body, field),
  );
  if (missing) return { field: missing, rule: "required" };

  const forbidden = profile.forbiddenFields?.find((field) =>
    hasFieldPath(body, field),
  );
  if (forbidden) return { field: forbidden, rule: "forbidden" };

  return undefined;
}

function fieldError(
  field: string,
  rule: StrictRelayRule,
): { body: FieldErrorBody; status: 400 } {
  return {
    status: 400,
    body: {
      error: {
        type: "strict_relay_field_error",
        field,
        rule,
        message: `strict relay rejected field '${field}' (${rule})`,
      },
    },
  };
}

function eventStream(
  events: ReadonlyArray<{ event?: string; data: unknown }>,
): string {
  return events
    .map(({ event, data }) => {
      const eventLine = event ? `event: ${event}\n` : "";
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      return `${eventLine}data: ${payload}\n\n`;
    })
    .join("");
}

function openAiCompletionsResponse(): string {
  return eventStream([
    {
      data: {
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: "relay-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "probe_ok" },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: "relay-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      },
    },
    { data: "[DONE]" },
  ]);
}

function openAiResponsesResponse(): string {
  const item = {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "probe_ok", annotations: [] },
    ],
  };
  const response = {
    id: "resp_probe",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "relay-model",
    output: [item],
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };

  return eventStream([
    {
      event: "response.created",
      data: {
        type: "response.created",
        sequence_number: 0,
        response: { ...response, status: "in_progress", output: [] },
      },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
    },
    {
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        sequence_number: 2,
        output_index: 0,
        item_id: "msg_probe",
        content_index: 0,
        delta: "probe_ok",
        logprobs: [],
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        sequence_number: 3,
        output_index: 0,
        item,
      },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        sequence_number: 4,
        response,
      },
    },
  ]);
}

function anthropicMessagesResponse(): string {
  return eventStream([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_probe",
          type: "message",
          role: "assistant",
          model: "relay-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "probe_ok" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function googleGenerativeAiResponse(): string {
  return eventStream([
    {
      data: {
        candidates: [
          {
            content: { parts: [{ text: "probe_ok" }], role: "model" },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
        modelVersion: "relay-model",
      },
    },
  ]);
}

function successBody(protocol: StrictRelayProtocol): string {
  switch (protocol) {
    case "openai-completions":
      return openAiCompletionsResponse();
    case "openai-responses":
      return openAiResponsesResponse();
    case "anthropic-messages":
      return anthropicMessagesResponse();
    case "google-generative-ai":
      return googleGenerativeAiResponse();
  }
}

function endpointPath(protocol: StrictRelayProtocol): string {
  switch (protocol) {
    case "openai-completions":
      return "/v1/chat/completions";
    case "openai-responses":
      return "/v1/responses";
    case "anthropic-messages":
      return "/v1/messages";
    case "google-generative-ai":
      return "/models/relay-model:streamGenerateContent";
  }
}

function matchesEndpoint(
  protocol: StrictRelayProtocol,
  pathname: string,
): boolean {
  if (protocol === "google-generative-ai") {
    return /^\/models\/[^/]+:streamGenerateContent$/.test(pathname);
  }
  return pathname === endpointPath(protocol);
}

export function createStrictRelay(
  protocol: StrictRelayProtocol,
  profile: StrictRelayProfile,
): StrictRelay {
  const requests: StrictRelayRequest[] = [];
  const rejections: StrictRelayRejection[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (request.method !== "POST" || !matchesEndpoint(protocol, pathname)) {
        return Response.json(
          { error: { type: "strict_relay_route_error" } },
          { status: 404 },
        );
      }

      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        const rejection = fieldError("$", "required");
        rejections.push({
          status: rejection.status,
          field: "$",
          rule: "required",
        });
        return Response.json(rejection.body, { status: rejection.status });
      }

      if (!isRecord(parsed)) {
        const rejection = fieldError("$", "required");
        rejections.push({
          status: rejection.status,
          field: "$",
          rule: "required",
        });
        return Response.json(rejection.body, { status: rejection.status });
      }

      requests.push({ method: request.method, pathname, body: parsed });
      const violation = validateBody(parsed, profile);
      if (violation) {
        const rejection = fieldError(violation.field, violation.rule);
        rejections.push({
          status: rejection.status,
          field: violation.field,
          rule: violation.rule,
        });
        return Response.json(rejection.body, { status: rejection.status });
      }

      return new Response(successBody(protocol), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  const path = endpointPath(protocol);
  return {
    origin,
    baseUrl:
      protocol === "openai-completions" || protocol === "openai-responses"
        ? `${origin}/v1`
        : origin,
    endpointUrl: `${origin}${path}`,
    requests,
    rejections,
    close: () => server.stop(true),
  };
}
