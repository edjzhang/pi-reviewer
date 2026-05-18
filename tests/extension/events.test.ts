import { describe, expect, it, vi } from "vitest";

import { extractAssistantText } from "../../src/core/output.js";
import { createEventAccumulator, sumMessagesUsage } from "../../extensions/pi-reviewer/events.js";

describe("extractAssistantText", () => {
  it("returns empty string for non-assistant message", () => {
    expect(extractAssistantText({ role: "user", content: "hello" })).toBe("");
  });

  it("returns string content directly", () => {
    expect(extractAssistantText({ role: "assistant", content: "LGTM" })).toBe("LGTM");
  });

  it("concatenates text parts from content array", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }],
    };
    expect(extractAssistantText(msg)).toBe("hello world");
  });

  it("skips non-text parts", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x" }, { type: "text", text: "done" }],
    };
    expect(extractAssistantText(msg)).toBe("done");
  });

  it("returns empty string for undefined message", () => {
    expect(extractAssistantText(undefined)).toBe("");
  });
});

describe("createEventAccumulator", () => {
  it("captures text from turn_end event", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({
      type: "turn_end",
      message: { role: "assistant", content: "Review result" },
    }));
    expect(acc.getLastReviewText()).toBe("Review result");
  });

  it("captures text from message_end event (pi --mode json format)", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: "Review from message_end" },
    }));
    expect(acc.getLastReviewText()).toBe("Review from message_end");
  });

  it("captures text from message_end with content array (thinking + text)", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this..." },
          { type: "text", text: "The actual review text" },
        ],
      },
    }));
    expect(acc.getLastReviewText()).toBe("The actual review text");
  });

  it("handles message_end after thinking events (no thinking-only error)", () => {
    const acc = createEventAccumulator(() => {});
    const onProgress = vi.fn();
    const accWithProgress = createEventAccumulator(() => {}, { onProgress });

    // Simulate pi --mode json event sequence: thinking_start, thinking_delta, text_start, text_delta, message_end
    accWithProgress.process(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    }));
    accWithProgress.process(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Analyzing..." },
    }));
    accWithProgress.process(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    }));
    accWithProgress.process(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Analyzing..." },
          { type: "text", text: "{ \"summary\": \"LGTM\", \"comments\": [] }" },
        ],
      },
    }));

    expect(accWithProgress.getLastReviewText()).toContain("LGTM");
    expect(accWithProgress.hadThinkingOnly()).toBe(false);
  });

  it("keeps last non-empty text across multiple turn_end events", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" } }));
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "user", content: "ignored" } }));
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "Final review" } }));
    expect(acc.getLastReviewText()).toBe("Final review");
  });

  it("preserves a valid review when a later turn has only preamble text", () => {
    const acc = createEventAccumulator(() => {});
    const validReview = JSON.stringify({
      summary: "Looks good",
      comments: [{ file: "src/index.ts", line: 1, side: "RIGHT", severity: "INFO", body: "Minor nit" }],
    });
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: validReview } }));
    // A later turn with only preamble text should not overwrite the valid review
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "Now I have enough information to complete the review." } }));
    expect(acc.getLastReviewText()).toBe(validReview);
  });

  it("accumulates partial text when no turn produces a valid review", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "Checking the files now." } }));
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "The diff looks reasonable." } }));
    expect(acc.getLastReviewText()).toBe("Checking the files now.\n\nThe diff looks reasonable.");
  });

  it("prefers valid review over accumulated partial text", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "Let me check." } }));
    const validReview = JSON.stringify({
      summary: "Found issues",
      comments: [{ file: "app.ts", line: 10, side: "RIGHT", severity: "WARN", body: "Missing error handling" }],
    });
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: validReview } }));
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "Done reviewing." } }));
    // The valid review should win, and the later preamble should not overwrite it
    expect(acc.getLastReviewText()).toBe(validReview);
  });

  it("preserves earlier text when a later turn has only tool-use content", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "First review" } }));
    acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "tool_use", id: "x" }] } }));
    // "First review" is not valid JSON review, so it accumulates.
    // The tool-use turn has no text content, so it doesn't add anything.
    expect(acc.getLastReviewText()).toBe("First review");
  });

  it("ignores non-turn_end events", () => {
    const acc = createEventAccumulator(() => {});
    acc.process(JSON.stringify({ type: "agent_start", message: { role: "assistant", content: "ignored" } }));
    expect(acc.getLastReviewText()).toBe("");
  });

  it("calls onUnexpected for non-JSON lines", () => {
    const onUnexpected = vi.fn();
    const acc = createEventAccumulator(onUnexpected);
    acc.process("not json at all");
    expect(onUnexpected).toHaveBeenCalledWith("not json at all");
    expect(acc.getLastReviewText()).toBe("");
  });

  it("skips blank lines silently", () => {
    const onUnexpected = vi.fn();
    const acc = createEventAccumulator(onUnexpected);
    acc.process("   ");
    expect(onUnexpected).not.toHaveBeenCalled();
  });

  describe("getTokenUsage", () => {
    function makeUsage(input: number, output: number, cost = 0) {
      return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } };
    }

    it("returns undefined when no turn_end had usage", () => {
      const acc = createEventAccumulator(() => {});
      acc.process(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "ok" } }));
      expect(acc.getTokenUsage()).toBeUndefined();
    });

    it("captures usage from a single turn_end", () => {
      const acc = createEventAccumulator(() => {});
      acc.process(JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "ok", usage: makeUsage(100, 50, 0.002) },
      }));
      expect(acc.getTokenUsage()).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.002 });
    });

    it("accumulates usage across multiple turn_end events", () => {
      const acc = createEventAccumulator(() => {});
      acc.process(JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "thinking", usage: makeUsage(200, 10, 0.001) },
      }));
      acc.process(JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "done", usage: makeUsage(300, 80, 0.003) },
      }));
      expect(acc.getTokenUsage()).toMatchObject({ inputTokens: 500, outputTokens: 90, totalTokens: 590, cost: 0.004 });
    });

    it("ignores turn_end with stopReason error and does not accumulate its usage", () => {
      const acc = createEventAccumulator(() => {});
      acc.process(JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "ok", stopReason: "error", usage: makeUsage(100, 50) },
      }));
      expect(acc.getTokenUsage()).toBeUndefined();
    });
  });
});

describe("sumMessagesUsage", () => {
  function makeAssistant(input: number, output: number, cost = 0) {
    return { role: "assistant", usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } } };
  }

  it("returns undefined for an empty array", () => {
    expect(sumMessagesUsage([])).toBeUndefined();
  });

  it("returns undefined when no assistant messages present", () => {
    expect(sumMessagesUsage([{ role: "user" }, { role: "toolResult" }])).toBeUndefined();
  });

  it("sums usage from a single assistant message", () => {
    expect(sumMessagesUsage([makeAssistant(100, 50, 0.002)])).toMatchObject({
      inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.002,
    });
  });

  it("sums usage across multiple assistant messages", () => {
    expect(sumMessagesUsage([makeAssistant(100, 20, 0.001), makeAssistant(200, 80, 0.003)])).toMatchObject({
      inputTokens: 300, outputTokens: 100, totalTokens: 400, cost: 0.004,
    });
  });

  it("ignores non-assistant messages", () => {
    const messages = [{ role: "user" }, makeAssistant(100, 50), { role: "toolResult" }];
    expect(sumMessagesUsage(messages)).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });
});
