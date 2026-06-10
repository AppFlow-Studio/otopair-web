/**
 * B-P1 (OTO_HANDOFF.md): production telemetry was fabricated — the
 * aggregation only replayed `trace.iterations`, which exists ONLY on debug
 * runs, so every production row recorded 0 tokens / 0 latency / constant
 * branch, and the model column always got the constant MODEL instead of the
 * routed turnModel.
 *
 * The fix extracts row assembly into a pure function over per-iteration
 * samples that chat.ts now collects unconditionally inside the tool loop.
 * This unit-tests that seam.
 */
import { describe, test, expect } from "vitest";
import {
  assembleTelemetryRow,
  shouldFlagStateSkip,
  STATE_TOOL_NAME,
  type TurnSample,
} from "../convex/oto/telemetryAssembly";

const OPTS = {
  model: "claude-haiku-4-5-20251001",
  systemPromptVersion: "v9.9-test",
  iterationsUsed: 2,
  hitCap: false,
};

describe("assembleTelemetryRow", () => {
  test("sums tokens and latency across iterations; tools kept in dispatch order", () => {
    const samples: TurnSample[] = [
      {
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 0,
        },
        latency_ms: 800,
        tool_names: ["get_vehicle_health", "update_conversation_state"],
        branch: "data_continue",
      },
      {
        usage: {
          input_tokens: 1500,
          output_tokens: 350,
          cache_read_input_tokens: 3000,
        },
        latency_ms: 650,
        tool_names: ["render_quick_replies"],
        branch: "terminal",
      },
    ];

    const row = assembleTelemetryRow(samples, OPTS);
    expect(row).toEqual({
      model: "claude-haiku-4-5-20251001",
      system_prompt_version: "v9.9-test",
      iterations_used: 2,
      hit_cap: false,
      input_tokens: 2500,
      output_tokens: 550,
      cache_creation_tokens: 3000,
      cache_read_tokens: 3000,
      total_latency_ms: 1450,
      tools_called: [
        "get_vehicle_health",
        "update_conversation_state",
        "render_quick_replies",
      ],
      final_branch: "terminal",
      state_called: true,
    });
  });

  test("state_called reflects whether the state tool appeared", () => {
    const withState = assembleTelemetryRow(
      [{ usage: null, latency_ms: 1, tool_names: [STATE_TOOL_NAME], branch: "text_only" }],
      OPTS,
    );
    expect(withState.state_called).toBe(true);

    const withoutState = assembleTelemetryRow(
      [{ usage: null, latency_ms: 1, tool_names: ["get_vehicle_health"], branch: "data_continue" }],
      OPTS,
    );
    expect(withoutState.state_called).toBe(false);
  });

  test("forced_final sample adds tokens/latency but never becomes final_branch", () => {
    const samples: TurnSample[] = [
      {
        usage: { input_tokens: 900, output_tokens: 120 },
        latency_ms: 700,
        tool_names: ["get_due_services"],
        branch: "data_continue",
      },
      {
        usage: { input_tokens: 400, output_tokens: 90 },
        latency_ms: 300,
        tool_names: [],
        branch: "forced_final",
      },
    ];

    const row = assembleTelemetryRow(samples, { ...OPTS, hitCap: true });
    expect(row.input_tokens).toBe(1300);
    expect(row.output_tokens).toBe(210);
    expect(row.total_latency_ms).toBe(1000);
    expect(row.hit_cap).toBe(true);
    expect(row.final_branch).toBe("data_continue");
  });

  test("zero cache totals collapse to undefined (matches old insert shape)", () => {
    const samples: TurnSample[] = [
      {
        usage: { input_tokens: 100, output_tokens: 20 },
        latency_ms: 100,
        tool_names: [],
        branch: "text_only",
      },
    ];
    const row = assembleTelemetryRow(samples, OPTS);
    expect(row.cache_creation_tokens).toBeUndefined();
    expect(row.cache_read_tokens).toBeUndefined();
  });

  test("missing usage on a sample is tolerated (retry/edge paths)", () => {
    const samples: TurnSample[] = [
      { usage: null, latency_ms: 250, tool_names: [], branch: "text_only" },
    ];
    const row = assembleTelemetryRow(samples, OPTS);
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.total_latency_ms).toBe(250);
    expect(row.final_branch).toBe("text_only");
  });

  test("empty sample list yields a zeroed row with the text_only default", () => {
    const row = assembleTelemetryRow([], OPTS);
    expect(row.input_tokens).toBe(0);
    expect(row.total_latency_ms).toBe(0);
    expect(row.tools_called).toEqual([]);
    expect(row.final_branch).toBe("text_only");
  });

  test("the routed model is passed through (Sonnet escalation turn)", () => {
    const row = assembleTelemetryRow([], {
      ...OPTS,
      model: "claude-sonnet-4-6",
    });
    expect(row.model).toBe("claude-sonnet-4-6");
  });
});

describe("shouldFlagStateSkip", () => {
  test("flags a non-trivial turn (data tool fired) that skipped state", () => {
    expect(shouldFlagStateSkip({ stateCalled: false, dataToolFired: true })).toBe(true);
  });
  test("does NOT flag a turn that called state", () => {
    expect(shouldFlagStateSkip({ stateCalled: true, dataToolFired: true })).toBe(false);
  });
  test("does NOT flag a trivial turn (no data tool) that skipped state", () => {
    expect(shouldFlagStateSkip({ stateCalled: false, dataToolFired: false })).toBe(false);
  });
});
