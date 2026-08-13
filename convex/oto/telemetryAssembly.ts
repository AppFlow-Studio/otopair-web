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

/** The conversation-state writeback tool (Locked Principle: every
 *  substantive turn should persist mood/arc/facts/intent). */
export const STATE_TOOL_NAME = "update_conversation_state";

/**
 * B-P2: a turn that engaged real context (a data tool fired) but never wrote
 * conversation state is an under-call — Haiku silently dropping the state
 * contract. Flagging these makes the under-call rate visible and tunable.
 * Pure; the caller supplies dataToolFired (it owns the tool-category map).
 */
export function shouldFlagStateSkip(args: {
  stateCalled: boolean;
  dataToolFired: boolean;
}): boolean {
  return args.dataToolFired && !args.stateCalled;
}

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
  /** B-P2: did the turn write conversation state at least once? */
  state_called: boolean;
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
    state_called: toolsCalled.includes(STATE_TOOL_NAME),
  };
}
