// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Composer, { FOLLOW_UP_MAX_CHARS } from './Composer';
import { I18nProvider } from '../i18n/I18nProvider';

const renderComposer = (props: React.ComponentProps<typeof Composer>) =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <Composer {...props} />
      </I18nProvider>
    </MemoryRouter>,
  );

describe('Composer — follow-up text caps', () => {
  afterEach(() => cleanup());

  it('caps follow-up input at 2000 chars (maxLength) with no counter below 1800', () => {
    renderComposer({ mode: 'followUp', onSubmitQuestion: () => {}, currentMatchId: '9035042364' });
    const input = screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement;
    expect(input.maxLength).toBe(FOLLOW_UP_MAX_CHARS);

    fireEvent.change(input, { target: { value: 'x'.repeat(1800) } });
    expect(screen.queryByText(/\/2000/)).toBeNull();
  });

  it('shows the subtle counter once past 1800 chars', () => {
    renderComposer({ mode: 'followUp', onSubmitQuestion: () => {}, currentMatchId: '9035042364' });
    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up about this match'), {
      target: { value: 'x'.repeat(1842) },
    });
    expect(screen.getByText('1842/2000')).toBeTruthy();
  });
});

describe('Composer — locked (429 countdown)', () => {
  afterEach(() => cleanup());

  it('disables input and submit without switching the send button to Stop', () => {
    renderComposer({ mode: 'followUp', locked: true, onStop: () => {}, onSubmitQuestion: () => {} });
    const input = screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement;
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    // Stop only appears while a stream is in flight (disabled), not while
    // rate-limited (locked).
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('still submits when not locked', () => {
    const onSubmitQuestion = vi.fn();
    renderComposer({
      mode: 'followUp',
      onSubmitQuestion,
      currentMatchId: '9035042364',
    });
    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up about this match'), {
      target: { value: '  why did we lose mid game?  ' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!);
    expect(onSubmitQuestion).toHaveBeenCalledWith('why did we lose mid game?');
  });
});
