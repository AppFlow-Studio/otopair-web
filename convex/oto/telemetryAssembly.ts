// =============================================================================
// Oto AI — pure telemetry-row assembly (B-P1, Jun-10)
// =============================================================================
//
// Why this module exists: production telemetry was fabricated. chat.ts
// aggregated tokens/latency/tools by replaying `trace.iterations`, but the
// trace only exists on debug runs — every production row recorded 0 tokens,
// 0 latency, an empty tool list, and a constant branch, which made
// cost-per-booking (Locked Principle #12) unverifiable. chat.ts now pushes
// one TurnSample per Anthropic round-trip unconditionally (plus one for the
// cap-hit forced-final call) and assembles the row here.
//
// Pure function, zero Convex deps — unit-tested in
// tests/telemetryAssembly.test.ts.
// =============================================================================

export type AnthropicUsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type TurnSample = {
  usage?: AnthropicUsageLike | null;
  latency_ms: number;
  /** Tool names in dispatch order: data, state, terminal. */
  tool_names: string[];
  branch: "terminal" | "text_only" | "data_continue" | "forced_final";
};

/** The oto_telemetry insert args minus the id fields chat.ts owns. */
export type TelemetryRowCore = {
  model: string;
  system_prompt_version: string;
  iterations_used: number;
  hit_cap: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number | undefined;
  cache_read_tokens: number | undefined;
  total_latency_ms: number;
  tools_called: string[];
  final_branch: string;
};

export function assembleTelemetryRow(
  samples: TurnSample[],
  opts: {
    /** The ROUTED model for this turn (turnModel), not the MODEL constant. */
    model: string;
    systemPromptVersion: string;
    iterationsUsed: number;
    hitCap: boolean;
  },
): TelemetryRowCore {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let totalLatencyMs = 0;
  const toolsCalled: string[] = [];
  let finalBranch = "text_only";

  for (const s of samples) {
    inputTokens += s.usage?.input_tokens ?? 0;
    outputTokens += s.usage?.output_tokens ?? 0;
    cacheCreation += s.usage?.cache_creation_input_tokens ?? 0;
    cacheRead += s.usage?.cache_read_input_tokens ?? 0;
    totalLatencyMs += s.latency_ms;
    toolsCalled.push(...s.tool_names);
    // The forced-final call is token/latency accounting only — the branch
    // that ended the loop is the meaningful one.
    if (s.branch !== "forced_final") finalBranch = s.branch;
  }

  return {
    model: opts.model,
    system_prompt_version: opts.systemPromptVersion,
    iterations_used: opts.iterationsUsed,
    hit_cap: opts.hitCap,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    // 0 collapses to undefined — matches the pre-existing insert shape
    // (optional columns omitted when the turn had no cache activity).
    cache_creation_tokens: cacheCreation || undefined,
    cache_read_tokens: cacheRead || undefined,
    total_latency_ms: totalLatencyMs,
    tools_called: toolsCalled,
    final_branch: finalBranch,
  };
}
