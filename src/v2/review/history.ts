/**
 * Bounded chat history for review follow-ups. The v2 follow-up endpoint
 * (POST /api/review/:id) is STATELESS — the client sends only the `followUp`
 * text, no history — so nothing here runs on the wire today. It is exported
 * as the single place to build the history window if/when the endpoint
 * starts accepting one, guaranteeing the same caps everywhere.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatHistoryOptions {
  /** Keep at most this many most-recent user/assistant turns. */
  maxTurns: number;
  /** Total character budget across all messages (oldest dropped first). */
  maxChars: number;
  /** Per-message cap applied after trimming. */
  maxMessageChars: number;
}

export const DEFAULT_CHAT_HISTORY_OPTIONS: ChatHistoryOptions = {
  maxTurns: 12,
  maxChars: 8000,
  maxMessageChars: 2000,
};

/**
 * Last ≤maxTurns user/assistant turns, each trimmed and capped at
 * maxMessageChars, then oldest-first drops until the total is ≤maxChars.
 * Unknown roles, empty/whitespace texts and nullish entries are discarded.
 */
export function buildChatHistory(
  turns: ReadonlyArray<{ role?: unknown; text?: unknown }>,
  options: Partial<ChatHistoryOptions> = {},
): ChatTurn[] {
  const opts = { ...DEFAULT_CHAT_HISTORY_OPTIONS, ...options };
  const cleaned = turns
    .filter(
      (turn): turn is { role: 'user' | 'assistant'; text: string } =>
        Boolean(turn) &&
        (turn?.role === 'user' || turn?.role === 'assistant') &&
        typeof turn?.text === 'string' &&
        turn.text.trim().length > 0,
    )
    .slice(-opts.maxTurns)
    .map((turn) => ({ role: turn.role, text: turn.text.trim().slice(0, opts.maxMessageChars) }));
  const totalChars = () => cleaned.reduce((sum, turn) => sum + turn.text.length, 0);
  while (cleaned.length > 0 && totalChars() > opts.maxChars) cleaned.shift();
  return cleaned;
}
