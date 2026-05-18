import { extractAssistantText, parseAgentResponse, type TokenUsage } from "../../src/core/output.js";

export interface EventAccumulator {
  process(line: string): void;
  getLastReviewText(): string;
  getTokenUsage(): TokenUsage | undefined;
  hadThinkingOnly(): boolean;
  hadAPIError(): boolean;
}

export interface EventAccumulatorOptions {
  onProgress?: (text: string) => void;
}

type RawUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
type RawUsageMessage = { role?: string; usage?: RawUsage };

function accumulateUsage(acc: TokenUsage, u: RawUsage): void {
  acc.inputTokens += u.input;
  acc.outputTokens += u.output;
  acc.cacheReadTokens += u.cacheRead;
  acc.cacheWriteTokens += u.cacheWrite;
  acc.totalTokens += u.totalTokens;
  acc.cost += u.cost.total;
  acc.turns += 1;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, turns: 0 };
}

/**
 * Try parsing text as a valid ReviewResult. Returns true if it has both
 * a string summary and a comments array of valid ReviewComment objects.
 */
function isValidReviewResult(text: string): boolean {
  const result = parseAgentResponse(text, "INFO");
  return result.comments.length > 0 || result.summary !== text;
  // If parseAgentResponse found valid JSON, summary will differ from raw text.
  // If it fell through to { summary: text, comments: [] }, the summary === text.
}

export function createEventAccumulator(
  onUnexpected: (line: string) => void,
  options?: EventAccumulatorOptions
): EventAccumulator {
  let bestReviewText = "";
  let textParts: string[] = [];
  let tokenUsage: TokenUsage | undefined;
  let thinkingBuf = "";
  let textStarted = false;
  let hadThinking = false;
  let apiError = false;

  return {
    process(line: string) {
      if (!line.trim()) return;

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        onUnexpected(line);
        return;
      }

      const ev = event as {
        type?: string;
        message?: unknown;
        assistantMessageEvent?: { type?: string; delta?: string };
      };

      if (ev?.type === "turn_end" || ev?.type === "message_end") {
        const msg = ev.message as (RawUsageMessage & { stopReason?: string }) | undefined;
        if (msg?.stopReason === "error") {
          apiError = true;
          return;
        }
        if (msg?.usage) {
          if (!tokenUsage) tokenUsage = emptyUsage();
          accumulateUsage(tokenUsage, msg.usage);
        }
        const text = extractAssistantText(ev.message);
        if (text) {
          // If this turn's text is a valid review on its own, use it directly.
          // Otherwise, accumulate it with previous partial texts so
          // parseAgentResponse can extract JSON from the concatenated result.
          if (isValidReviewResult(text)) {
            bestReviewText = text;
            textParts = [];
          } else {
            textParts.push(text);
          }
        }
      } else if (ev?.type === "message_update") {
        const aev = ev.assistantMessageEvent;
        if (!aev || !options?.onProgress) return;

        if (aev.type === "thinking_start" || aev.type === "thinking_delta") {
          hadThinking = true;
        }

        if (aev.type === "thinking_start") {
          options.onProgress("Thinking…");
        } else if (aev.type === "thinking_delta" && aev.delta) {
          thinkingBuf += aev.delta;
          const sentenceEnd = Math.max(thinkingBuf.lastIndexOf(". "), thinkingBuf.lastIndexOf(".\n"));
          if (sentenceEnd > 60) {
            options.onProgress(thinkingBuf.slice(0, sentenceEnd + 1).trim());
            thinkingBuf = thinkingBuf.slice(sentenceEnd + 1);
          }
        } else if (aev.type === "text_start" && !textStarted) {
          textStarted = true;
          options.onProgress("Writing review…");
        }
      }
    },

    getLastReviewText() {
      // If we found a valid review, return it.
      // Otherwise, concatenate accumulated text parts so parseAgentResponse
      // can try to extract JSON from the combined output.
      if (bestReviewText) return bestReviewText;
      if (textParts.length > 0) return textParts.join("\n\n");
      return "";
    },

    getTokenUsage() {
      return tokenUsage;
    },

    hadThinkingOnly() {
      return hadThinking && !bestReviewText && textParts.length === 0;
    },

    hadAPIError() {
      return apiError;
    },
  };
}

export function sumMessagesUsage(messages: unknown[]): TokenUsage | undefined {
  const acc = emptyUsage();
  for (const msg of messages) {
    const m = msg as RawUsageMessage;
    if (m.role === "assistant" && m.usage) accumulateUsage(acc, m.usage);
  }
  return acc.totalTokens > 0 ? acc : undefined;
}
