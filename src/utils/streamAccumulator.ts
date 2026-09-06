/**
 * Stream accumulation utilities.
 * 
 * These helpers implement the correct pattern for accumulating SSE stream chunks
 * in React state. The key insight from the CoachView streaming bug (PR #11) is that
 * closures over state arrays become stale during async streaming - the only safe
 * pattern is functional state updates that use the previous state directly.
 */

export interface StreamMessage {
  id: string;
  content: string;
  isStreaming?: boolean;
}

/**
 * Appends a text chunk to a message's content.
 * 
 * This is the pure function extracted from the fixed CoachView pattern.
 * CORRECT: Use this with functional setState: setMessages(prev => appendStreamChunk(prev, id, text))
 * WRONG: messages.find(m => m.id === id)?.content + text (stale closure bug)
 * 
 * @param messages - Current messages array
 * @param targetId - ID of message to update
 * @param chunk - Text chunk to append
 * @returns New messages array with chunk appended
 */
export function appendStreamChunk<T extends StreamMessage>(
  messages: T[],
  targetId: string,
  chunk: string
): T[] {
  return messages.map(msg =>
    msg.id === targetId
      ? { ...msg, content: msg.content + chunk }
      : msg
  );
}

/**
 * Demonstrates the anti-pattern that causes the stale closure bug.
 * DO NOT USE - only here for documentation and regression test purposes.
 * 
 * The bug: capturing `messages` array in a closure, then using messages.find()
 * to read content during streaming. Each SSE chunk sees the same stale array,
 * so content gets overwritten instead of accumulated.
 */
export function _buggyAppendPattern_DO_NOT_USE<T extends StreamMessage>(
  staleMessages: T[],
  targetId: string,
  chunk: string
): string {
  const found = staleMessages.find(m => m.id === targetId);
  return (found?.content || '') + chunk;
}

/**
 * Generates a unique message ID safe for rapid sequential calls.
 * Date.now() alone can collide when called within the same millisecond.
 */
export function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Simulates multi-chunk stream accumulation to verify the pattern works correctly.
 * Used for testing that content accumulates properly without collapse.
 */
export function simulateStreamAccumulation(
  initialContent: string,
  chunks: string[]
): string {
  let messages: StreamMessage[] = [{ id: 'test', content: initialContent }];
  
  for (const chunk of chunks) {
    messages = appendStreamChunk(messages, 'test', chunk);
  }
  
  return messages[0].content;
}
