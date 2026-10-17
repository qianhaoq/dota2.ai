import { describe, it, expect } from 'vitest';
import { serverErrorMessage } from './serverErrorMessage';

describe('serverErrorMessage', () => {
  it('prefers the localized message from the sanitized LLM payload', () => {
    expect(
      serverErrorMessage(
        { error: 'ai_unavailable', message: 'AI service temporarily unavailable' },
        'default',
      ),
    ).toBe('AI service temporarily unavailable');
    expect(
      serverErrorMessage(
        { error: 'ai_unavailable', message: 'AI 服务暂时不可用' },
        'default',
      ),
    ).toBe('AI 服务暂时不可用');
  });

  it('falls back to error when message is absent or blank', () => {
    expect(serverErrorMessage({ error: 'Failed to analyze draft' }, 'default')).toBe(
      'Failed to analyze draft',
    );
    expect(serverErrorMessage({ error: 'boom', message: '' }, 'default')).toBe('boom');
    expect(serverErrorMessage({ error: 'boom', message: '   ' }, 'default')).toBe('boom');
  });

  it('falls back to the caller default when neither field is usable', () => {
    expect(serverErrorMessage({}, 'default')).toBe('default');
    expect(serverErrorMessage({ error: '' }, 'default')).toBe('default');
    expect(serverErrorMessage({ error: 500, message: null }, 'default')).toBe('default');
    expect(serverErrorMessage(undefined, 'default')).toBe('default');
    expect(serverErrorMessage(null, 'default')).toBe('default');
    expect(serverErrorMessage('not an object', 'default')).toBe('default');
  });
});
