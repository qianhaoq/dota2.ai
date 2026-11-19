// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import type { CoachReport } from './types';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', setLang: () => {} }) }));
const askCoach = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), askCoach: (...a: unknown[]) => askCoach(...a) }));
const { Chapters } = await import('./Chapters');

afterEach(() => { cleanup(); askCoach.mockReset(); });
const report = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'))) as unknown as CoachReport;

describe('AskPanel', () => {
  it('switching player starts a fresh conversation and aborts the old stream', async () => {
    let signal: AbortSignal | undefined;
    askCoach.mockImplementation((_id, _in, ev, sig) => { signal = sig; ev.onText('Answer for Tidehunter.', false); return new Promise(() => {}); });
    const { rerender } = render(<Chapters review={report.reviews[0]} report={report} pos={null} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByText('Answer for Tidehunter.')).toBeTruthy());
    rerender(<Chapters review={report.reviews[4]} report={report} pos={null} />);
    expect(screen.queryByText('Answer for Tidehunter.')).toBeNull();
    expect(signal?.aborted).toBe(true);
    askCoach.mockImplementation(async (_id, input, ev) => { ev.onText('ok', false); expect(input.history).toEqual([]); expect(input.slot).toBe(4); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Next?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(askCoach).toHaveBeenCalledTimes(2));
  });
});
