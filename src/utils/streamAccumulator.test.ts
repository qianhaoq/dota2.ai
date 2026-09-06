import { describe, it, expect, vi } from 'vitest';
import {
  appendStreamChunk,
  generateMessageId,
  simulateStreamAccumulation,
  _buggyAppendPattern_DO_NOT_USE,
  StreamMessage
} from './streamAccumulator';

describe('appendStreamChunk', () => {
  it('appends chunk to existing content', () => {
    const messages: StreamMessage[] = [
      { id: '1', content: 'Hello' }
    ];
    
    const result = appendStreamChunk(messages, '1', ' World');
    
    expect(result[0].content).toBe('Hello World');
  });

  it('accumulates multiple chunks correctly', () => {
    let messages: StreamMessage[] = [
      { id: 'msg1', content: '' }
    ];
    
    const chunks = ['## ', '分析', '思路', '\n', '这是', '一段', '完整的', '分析'];
    
    for (const chunk of chunks) {
      messages = appendStreamChunk(messages, 'msg1', chunk);
    }
    
    expect(messages[0].content).toBe('## 分析思路\n这是一段完整的分析');
  });

  it('does NOT collapse to last token (regression: PR #11)', () => {
    let messages: StreamMessage[] = [
      { id: 'coach', content: '', isStreaming: true }
    ];
    
    const chunks = ['.', '.'];
    
    for (const chunk of chunks) {
      messages = appendStreamChunk(messages, 'coach', chunk);
    }
    
    expect(messages[0].content).toBe('..');
    expect(messages[0].content).not.toBe('.');
  });

  it('preserves other messages unchanged', () => {
    const messages: StreamMessage[] = [
      { id: '1', content: 'User message' },
      { id: '2', content: 'Streaming' }
    ];
    
    const result = appendStreamChunk(messages, '2', ' response');
    
    expect(result[0].content).toBe('User message');
    expect(result[1].content).toBe('Streaming response');
  });

  it('returns unchanged array if target ID not found', () => {
    const messages: StreamMessage[] = [
      { id: '1', content: 'Hello' }
    ];
    
    const result = appendStreamChunk(messages, 'nonexistent', ' chunk');
    
    expect(result[0].content).toBe('Hello');
  });
});

describe('simulateStreamAccumulation', () => {
  it('accumulates full stream correctly', () => {
    const chunks = ['H', 'e', 'l', 'l', 'o', ' ', 'W', 'o', 'r', 'l', 'd'];
    const result = simulateStreamAccumulation('', chunks);
    
    expect(result).toBe('Hello World');
  });

  it('handles Chinese characters in stream', () => {
    const chunks = ['你', '好', '世', '界'];
    const result = simulateStreamAccumulation('', chunks);
    
    expect(result).toBe('你好世界');
  });

  it('handles mixed markdown content', () => {
    const chunks = [
      '## ', '🧠 ', '分析', '思路', '\n\n',
      '这是', 'AI', '教练的', '分析', '...'
    ];
    const result = simulateStreamAccumulation('', chunks);
    
    expect(result).toBe('## 🧠 分析思路\n\n这是AI教练的分析...');
  });
});

describe('generateMessageId', () => {
  it('generates unique IDs even when called rapidly', () => {
    const ids = new Set<string>();
    
    for (let i = 0; i < 100; i++) {
      ids.add(generateMessageId());
    }
    
    expect(ids.size).toBe(100);
  });

  it('generates IDs with timestamp prefix', () => {
    const before = Date.now();
    const id = generateMessageId();
    const after = Date.now();
    
    const timestamp = parseInt(id.split('-')[0], 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('stale closure bug regression (PR #11)', () => {
  it('demonstrates the buggy pattern causes content loss', () => {
    const staleMessages: StreamMessage[] = [
      { id: 'msg', content: '' }
    ];
    
    const chunk1Result = _buggyAppendPattern_DO_NOT_USE(staleMessages, 'msg', 'Hello');
    const chunk2Result = _buggyAppendPattern_DO_NOT_USE(staleMessages, 'msg', ' World');
    
    expect(chunk2Result).toBe(' World');
    expect(chunk2Result).not.toBe('Hello World');
  });

  it('correct pattern accumulates properly', () => {
    let messages: StreamMessage[] = [
      { id: 'msg', content: '' }
    ];
    
    messages = appendStreamChunk(messages, 'msg', 'Hello');
    messages = appendStreamChunk(messages, 'msg', ' World');
    
    expect(messages[0].content).toBe('Hello World');
  });
});
