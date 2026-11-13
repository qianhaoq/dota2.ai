// @vitest-environment jsdom
/** PR6 migrates the page contract from legacy facts/2000-char asks to SSE v1/300-char asks.
 * Regression coverage below keeps cancellation, Stop, retry, language, trace,
 * hero selection, verbatim numbers, flags and analytics against the real engine. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { buildReview } from '../../../packages/review-engine/src/index.js';
import { applyReplayArtifact } from '../../../packages/review-engine/src/replay.js';
import MatchPage from './MatchPage';
import { I18nProvider } from '../i18n/I18nProvider';
import { trackEvent } from '../../services/analytics';
import type { Review } from '../review/types';
vi.mock('../../services/analytics', () => ({ trackEvent: vi.fn() }));
const flags = { fakedoor_v2: true };
vi.mock('../FlagsProvider', () => ({ useFlags: () => flags }));
const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json', 'utf8'));
const other = JSON.parse(readFileSync('src/fixtures/match8985182860.json', 'utf8'));
function engine(data = raw, heroId: number | null = 14, lang: string = 'en'): Review {
    return buildReview(data, { heroId: heroId ?? undefined, lang: lang === 'zh' ? 'zh' : 'en', fetchedAt: '2026-10-17T00:00:00Z', presetFollowups: true }) as unknown as Review;
}
export const frame = (event: string, data: unknown, id?: number) => `${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function response(text: string, open = false) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) {
            controller = c;
            if (text)
                c.enqueue(new TextEncoder().encode(text));
            if (!open)
                c.close();
        } });
    return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), push: (text: string) => controller.enqueue(new TextEncoder().encode(text)) };
}
function events(review: Review) {
    let id = 0;
    return 'retry: 0\n\n: ping\n\n' + frame('progress', { step: 'fetch_match', status: 'done', ms: 10 }, ++id) + (!review.player ? frame('hero_pick', { roster: review.roster }, ++id) : '') + frame('card', { kind: 'result_header', payload: { match: review.match, player: review.player } }, ++id) + review.insights.map((payload, i) => frame('card', { kind: 'insight', index: i + 1, payload }, ++id)).join('') + frame('card', { kind: 'followups', payload: review.followups }, ++id) + frame('done', { state: review.player ? review.state : 'needs_hero', ...(!review.player ? { needs: 'hero' } : {}), review }, ++id);
}
const fetcher = vi.fn();
function stub(data = raw) {
    fetcher.mockImplementation((input: string, init?: RequestInit) => {
        if (init?.method === 'POST')
            return Promise.resolve(response(frame('token', { target: 'answer', delta: 'Evidence answer' }) + frame('done', { state: 'parsed', answer: 'Evidence answer', phrasing: 'template' })).response);
        const url = new URL(input, 'http://test');
        const hero = url.searchParams.get('hero');
        return Promise.resolve(response(events(engine(data, hero ? hero === 'pudge' ? 14 : Number(hero) : null, url.searchParams.get('lang') ?? 'en'))).response);
    });
    vi.stubGlobal('fetch', fetcher);
}
function Controls() {
    const navigate = useNavigate();
    return <><button onClick={() => navigate('/m/9035042364?hero=14&lang=zh')}>Switch language</button><button onClick={() => navigate('/m/8985182860?hero=14')}>Switch match</button><button onClick={() => navigate('/m')}>Bare route</button></>;
}
function page(route = '/m/9035042364?hero=pudge&lang=en') {
    return render(<MemoryRouter initialEntries={[route]}><I18nProvider><Controls /><Routes><Route path="/m/:matchId?" element={<MatchPage />}/></Routes></I18nProvider></MemoryRouter>);
}
async function ready() {
    await screen.findAllByTestId('insight-card');
    fireEvent.click(await screen.findByRole('button', { name: /Share|分享/ }));
    await screen.findByText(/Copy JSON|复制 JSON/);
}
async function flush() {
    await act(async () => {
        await new Promise(r => setTimeout(r, 0));
    });
}
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    flags.fakedoor_v2 = true;
    stub();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('SSE v1 conversation', () => {
    for (const lang of ['en', 'zh'])
        it(`renders short conclusions with matchup/details hierarchy (${lang})`, async () => {
            page(`/m/9035042364?hero=14&lang=${lang}`);
            const r = engine(raw, 14, lang);
            await screen.findByText(r.insights[0].claim.text);
            for (const insight of r.insights) {
                expect(screen.getByText(insight.claim.text)).toBeTruthy();
            }
            expect(screen.getAllByTestId('insight-card')).toHaveLength(3);
            expect(screen.getAllByTestId('card-conclusion')).toHaveLength(3);
            expect(screen.getAllByTestId('card-matchup')).toHaveLength(3);
            // fix_this killers are localized rows, not slug aggregates
            expect(screen.getAllByTestId('killer-row').length).toBeGreaterThan(0);
            expect(screen.queryByText(/doom_bringer|skeleton_king/)).toBeNull();
            if (lang === 'zh') {
                expect(screen.getByText('冥魂大帝')).toBeTruthy();
                expect(screen.getAllByText('结论').length).toBe(3);
            } else {
                expect(screen.getByText('Wraith King')).toBeTruthy();
                expect(screen.getAllByText('Conclusion').length).toBe(3);
            }
            // Details still surface labeled gold.low for turning_point
            const low = r.facts['gold.low'];
            const lowLabel = lang === 'zh' ? '全局低点' : 'Gold low';
            expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes(lowLabel) && (el.textContent ?? '').includes(low.display[lang as 'en' | 'zh']))).toBeTruthy();
            expect(screen.getByText(`${lang === 'zh' ? '天辉' : 'Radiant'} · ${r.player!.kda!.join('/')}`)).toBeTruthy();
        });
    it('renders the second golden sample from the real engine', async () => {
        stub(other);
        page(`/m/8985182860?hero=${other.players[0].hero_id}`);
        const r = engine(other, other.players[0].hero_id);
        await screen.findByText(r.insights[0].claim.text);
        for (const i of r.insights) {
            expect(screen.getByText(i.claim.text)).toBeTruthy();
        }
        expect(screen.getAllByTestId('insight-card')).toHaveLength(3);
        expect(screen.getAllByTestId('card-conclusion')).toHaveLength(3);
    });
    for (const state of ['unparsed', 'insufficient'])
        it(`renders ${state} and its engine insights`, async () => {
            const r = engine();
            r.state = state;
            fetcher.mockResolvedValue(response(events(r)).response);
            page();
            await ready();
            if (state === 'unparsed') {
                expect(screen.getByRole('button', { name: 'Request parse' })).toBeTruthy();
            } else {
                expect(screen.getByText('Insufficient data')).toBeTruthy();
            }
        });
    it('unparsed requests a parse and Check again restarts the review stream', async () => {
        const r = engine();
        r.state = 'unparsed';
        fetcher.mockResolvedValueOnce(response(events(r)).response)
            .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'requested', jobId: 42, retryAfterSec: 30, message: 'Parse requested' }), { headers: { 'Content-Type': 'application/json' } }));
        page();
        fireEvent.click(await screen.findByRole('button', { name: 'Request parse' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
        expect(fetcher.mock.calls[1][0]).toBe('/api/review/9035042364/parse-request?lang=en');
        expect(fetcher.mock.calls[1][1].method).toBe('POST');
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Request parse' })).toBeNull());
    });
    it('needs_hero shows a 2×5 roster; picking requests hero=pudge and Change reopens it', async () => {
        page('/m/9035042364?lang=en');
        await screen.findByText('Which one was you?');
        expect(screen.getAllByRole('button').filter(b => b.querySelector('img'))).toHaveLength(10);
        fireEvent.click(screen.getByRole('button', { name: /^Pudge\b/ }));
        await ready();
        expect(fetcher.mock.calls.some(([url]) => url.includes('hero=pudge'))).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Change' }));
        expect(screen.getByText('Which one was you?')).toBeTruthy();
        const calls = fetcher.mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: /^Pudge\b/ }));
        await flush();
        expect(fetcher.mock.calls.length).toBe(calls);
    });
    it('terminal error localizes message_key and never exposes upstream text', async () => {
        fetcher.mockResolvedValue(response(frame('error', { code: 'UPSTREAM_TIMEOUT', message_key: 'err.upstream_timeout', retryable: true, message: 'SECRET upstream boom' }) + events(engine())).response);
        page();
        await screen.findByText('The data source timed out. Please retry.');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(screen.queryByText(/SECRET/)).toBeNull();
        expect(screen.queryAllByTestId('insight-card')).toHaveLength(0);
        expect(screen.queryByText('Analyzed match · OpenDota')).toBeNull();
    });
    it('nonretryable error offers no Retry', async () => {
        fetcher.mockResolvedValue(response(frame('error', { code: 'MATCH_NOT_FOUND', message_key: 'err.match_not_found', retryable: false })).response);
        page();
        await screen.findByText('Match not found');
        expect(screen.queryByText('Retry')).toBeNull();
    });
    it('Retry starts a fresh request', async () => {
        fetcher.mockResolvedValueOnce(response(frame('error', { ...{ code: 'INTERNAL', message_key: 'err.internal', retryable: true } })).response);
        page();
        fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
        await ready();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('JSON fallback sends Accept and renders the same engine payload', async () => {
        fetcher.mockRejectedValueOnce(new Error('unsupported')).mockResolvedValueOnce(new Response(JSON.stringify(engine()), { headers: { 'Content-Type': 'application/json' } }));
        page();
        await ready();
        expect(fetcher.mock.calls[1][1].headers.Accept).toBe('application/json');
    });
    it('reconnects with Last-Event-ID; duplicate replay does not duplicate cards', async () => {
        const r = engine();
        const card = { kind: 'insight', index: 1, payload: r.insights[0] };
        fetcher.mockResolvedValueOnce(response('retry: 0\n\n' + frame('card', card, 1)).response).mockResolvedValueOnce(response(frame('card', card, 1) + frame('done', { state: 'parsed', review: r }, 2)).response);
        page();
        fireEvent.click(await screen.findByRole('button', { name: /Share|分享/ }));
        await screen.findByText(/Copy JSON|复制 JSON/);
        expect(fetcher.mock.calls[1][1].headers['Last-Event-ID']).toBe('1');
        expect(screen.getAllByTestId('insight-card')).toHaveLength(1);
    });
    it('tracks review_viewed once per match and hero after cards render', async () => {
        const view = page();
        await ready();
        view.rerender(<MemoryRouter><MatchPage /></MemoryRouter>);
        await flush();
        expect(vi.mocked(trackEvent).mock.calls.filter(([e]) => e === 'review_viewed')).toHaveLength(1);
        expect(trackEvent).toHaveBeenCalledWith('review_viewed', expect.objectContaining({ ui: 'v2', surface: 'web', lang: 'en', phrasing: 'template' }));
    });
    it('does not track a view without cards', async () => {
        const r = engine();
        r.insights = [];
        fetcher.mockResolvedValue(response(events(r)).response);
        page();
        fireEvent.click(await screen.findByRole('button', { name: /Share|分享/ }));
        await screen.findByText(/Copy JSON|复制 JSON/);
        expect(vi.mocked(trackEvent).mock.calls.filter(([e]) => e === 'review_viewed')).toHaveLength(0);
    });
    it.each(['en','zh'])('renders the official replay as moments and readable timelines (%s)', async lang => {
        const artifact = JSON.parse(readFileSync('data/replay-facts/9080127650.json','utf8'));
        const match = {match_id:9080127650,duration:1906.767,radiant_win:true,players:artifact.players.map((p: {hero_id:number;player_slot:number})=>({hero_id:p.hero_id,player_slot:p.player_slot,...(p.hero_id===60?{kills:4,deaths:8,assists:6}:{})}))};
        const r = engine(applyReplayArtifact(match,artifact),60,lang);
        fetcher.mockResolvedValue(response(events(r)).response);
        const view=page(`/m/9080127650?hero=60&lang=${lang}`);
        await screen.findAllByTestId('insight-card');
        expect(screen.getAllByTestId('insight-card')).toHaveLength(5);
        expect(screen.getByText((_,el)=>el?.tagName==='LI' && !!el.textContent?.includes(lang==='zh'?'冥魂大帝骨卫骷髅':'Wraith King skeleton'))).toBeTruthy();
        expect(screen.getByText(lang==='zh'?'关键购买记录':'Key purchases')).toBeTruthy();
        expect(screen.getByText(lang==='zh'?'本局还缺什么':'What remains unverified')).toBeTruthy();
        expect(screen.queryByRole('img',{name:lang==='zh'?'经济与经验差':'Gold and experience advantage'})).toBeNull();
        expect(view.container.textContent).not.toMatch(/state_sample|sample_t|net_worth_t|trace_version|trace\//);
        expect(screen.queryByRole('button',{name:'Notify me'})).toBeNull();
    });
    for (const lang of ['en', 'zh']) it(`discloses scoreboard-only 9080127650 and avoids unsupported requests (${lang})`, async () => {
        const r = JSON.parse(readFileSync('src/fixtures/review9080127650.scoreboard.json', 'utf8')) as Review;
        fetcher.mockResolvedValue(response(events(r).replace('"review":', '"timings":{"total_display":"0.0"},"review":')).response);
        page(`/m/9080127650?hero=60&lang=${lang}`);
        await screen.findByText(lang === 'en' ? 'Scoreboard summary only — detailed review unavailable' : '仅终局记分板摘要 — 详细复盘不可用');
        expect(screen.queryByText(/Analyzed in|分析耗时|Reading timeline|Building 3 conclusions/)).toBeNull();
        expect(screen.getByText(lang === 'en' ? /OpenDota has not parsed/ : /OpenDota 尚未解析/)).toBeTruthy();
        expect(screen.getByText(lang === 'en' ? /Official .dem ingest is not enabled/ : /未启用官方 .dem/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /查看死亡记录/ })).toBeNull();
        expect(screen.getByText(lang === 'en' ? 'What remains unverified' : '本局还缺什么')).toBeTruthy();
        const input = screen.getByPlaceholderText(lang === 'en' ? 'Ask a follow-up about this match' : '继续追问这场比赛');
        for (const question of ['which build?', 'when should I have bought bkb?', 'where were the wards?']) {
            fireEvent.change(input, { target: { value: question } });
            fireEvent.submit(input.closest('form')!);
        }
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    });
    for (const timing of [undefined, '0.0', '1.5']) it(`keeps parsed insufficient evidence distinct from scoreboard-only (${timing})`, async () => {
        const r = engine();
        r.state = 'insufficient';
        expect(r.match.parsed).toBe(true);
        expect(r.insights.length).toBeGreaterThan(0);
        expect(Object.keys(r.facts).length).toBeGreaterThan(0);
        fetcher.mockResolvedValue(response(frame('done', { state: 'insufficient', review: r, timings: { total_display: timing } })).response);
        page();
        await screen.findByText(timing === '1.5' ? 'Analyzed in 1.5s' : 'Analyzed match · OpenDota');
        expect(screen.queryByText('Scoreboard summary only — detailed review unavailable')).toBeNull();
        expect(screen.queryByText('Analyzed in 0.0s')).toBeNull();
        expect(screen.getByText('Insufficient data')).toBeTruthy();
    });
    for (const lang of ['en', 'zh']) it(`explains parsed topic gaps locally (${lang})`, async () => {
        page(`/m/9035042364?hero=pudge&lang=${lang}`);
        const input = await screen.findByPlaceholderText(lang === 'en' ? 'Ask a follow-up about this match' : '继续追问这场比赛');
        for (const [question, explanation] of [
            ['death coordinates?', lang === 'en' ? 'The OpenDota death log has no coordinates, so position and vision cannot be judged.' : 'OpenDota 死亡日志没有坐标，无法判断站位与视野。'],
            ['same bracket baseline?', lang === 'en' ? 'No same-bracket laning baseline is available, so these numbers cannot be graded against peers.' : '缺少同段位对线基准，无法用这些数据评价同段位表现。'],
        ]) {
            fireEvent.change(input, { target: { value: question } });
            fireEvent.submit(input.closest('form')!);
            await screen.findByText(explanation);
        }
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
        expect(document.body.textContent).not.toMatch(/opendota_deaths_log_has_no_coordinates|details below|request an OpenDota parse/);
    });
    it('renders the server-formatted elapsed time without computing a screen number', async () => {
        fetcher.mockResolvedValue(response(frame('done', { state: 'parsed', review: engine(), timings: { total_ms: 1549, total_display: '1.5' } })).response);
        page();
        const label = await screen.findByText('Analyzed in 1.5s');
        expect(label.closest('details')?.open).toBe(false);
    });
    it('shows progress while pending and collapses after done', async () => {
        const gated = response(frame('progress', { step: 'fetch_match', status: 'active' }), true);
        fetcher.mockResolvedValue(gated.response);
        page();
        await screen.findAllByText('Fetching match');
        expect(screen.queryByText('Analyzed match · OpenDota')).toBeNull();
        gated.push(events(engine()));
        await ready();
        expect(screen.getByText('Analyzed match · OpenDota').closest('details')?.open).toBe(false);
    });
    it('preset POST uses followup_id; asked chip disappears and answer appears', async () => {
        page();
        await ready();
        fireEvent.click(screen.getByRole('button', { name: 'Death list' }));
        await screen.findByText('Evidence answer');
        expect(screen.queryByRole('button', { name: 'Death list' })).toBeNull();
        const body = JSON.parse(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1].body);
        expect(body).toEqual({ hero: 'pudge', lang: 'en', followup_id: 'death_list' });
        expect(trackEvent).toHaveBeenCalledWith('followup_clicked', { followup_id: 'death_list', answerable: true });
    });
    it('free question uses question and rejects over 300 characters before sending', async () => {
        page();
        await ready();
        const input = screen.getByPlaceholderText('Ask a follow-up about this match');
        fireEvent.change(input, { target: { value: 'x'.repeat(301) } });
        fireEvent.submit(input.closest('form')!);
        await screen.findByText('Please keep questions under 300 characters.');
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
        fireEvent.change(input, { target: { value: 'my deaths?' } });
        fireEvent.submit(input.closest('form')!);
        await screen.findByText('Evidence answer');
        expect(trackEvent).toHaveBeenCalledWith('followup_clicked', { followup_id: 'free', answerable: true });
    });
    it('keeps unavailable evidence out of followup chips', async () => {
        page(); await ready();
        expect(screen.queryByRole('button', { name: /Missing evidence/ })).toBeNull();
        expect(screen.getByText('What remains unverified')).toBeTruthy();
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    });
    for (const question of ['which build?', 'when should I have bought bkb?'])
        it(`routes parsed item question to an evidence stream: ${question}`, async () => {
            page();
            await ready();
            expect(engine().followups.find(f => f.id === 'item_timings')?.answerable).toBe(true);
            const input = screen.getByPlaceholderText('Ask a follow-up about this match');
            fireEvent.change(input, { target: { value: question } });
            fireEvent.submit(input.closest('form')!);
            await screen.findByText('Evidence answer');
            const posts = fetcher.mock.calls.filter(([url, init]) => String(url).includes('/ask') && init?.method === 'POST');
            expect(posts).toHaveLength(1);
            expect(screen.queryByTestId('refusal-bubble')).toBeNull();
            expect(screen.queryByText(/The available evidence cannot answer/)).toBeNull();
            expect(screen.queryByText(/no_compliant_patch_matched_kb/)).toBeNull();
        });
    it('parsed needs_hero shows the hero grid with neutral match status', async () => {
        page('/m/9035042364?lang=en');
        await screen.findByText('Which one was you?');
        expect(screen.getByRole('button', { name: /Pudge/ })).toBeTruthy();
        await screen.findByText('Analyzed match · OpenDota');
        expect(screen.queryByText('Scoreboard summary only — detailed review unavailable')).toBeNull();
        expect(screen.queryByText(/Analyzed in/)).toBeNull();
    });
    it('service timeout keeps the partial answer and offers Retry', async () => {
        page();
        await ready();
        const gated = response('', true);
        fetcher.mockResolvedValueOnce(gated.response);
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Death list' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        gated.push(frame('token', { target: 'answer', delta: 'Partial before timeout' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
        expect(screen.getByText('Partial before timeout')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        expect((screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled).toBe(false);
    });
    it('killer matchup uses localized names; missing gold-fed evidence stays unavailable', async () => {
        page(); await ready(); const r = engine();
        // Structured matchup rows — never the slug aggregate string as primary copy.
        expect(screen.queryByText(r.facts.killed_by.display.en)).toBeNull();
        expect(screen.getAllByTestId('killer-row').length).toBeGreaterThan(0);
        expect(screen.getByText('Wraith King')).toBeTruthy();
        expect(screen.queryByText(/doom_bringer/)).toBeNull();
        // gold.low stays in the details chips for turning_point (with metric label)
        expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes('Gold low') && (el.textContent ?? '').includes(r.facts['gold.low'].display.en))).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Gold fed · Missing evidence' })).toBeNull();
        expect(screen.getByText('What remains unverified')).toBeTruthy();
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    });
    it('Stop preserves partial answer and releases the composer', async () => {
        const gated = response('', true);
        page();
        await ready();
        fetcher.mockResolvedValue(gated.response);
        fireEvent.click(screen.getByRole('button', { name: 'Death list' }));
        await flush();
        gated.push(frame('token', { target: 'answer', delta: 'PARTIAL' }));
        await screen.findByText('PARTIAL');
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect((screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled).toBe(false);
        expect(screen.getByText('PARTIAL')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });
    it('follow-up terminal error is localized with retry; partial text stays', async () => {
        page();
        await ready();
        fetcher.mockResolvedValueOnce(response(frame('token', { target: 'answer', delta: 'partial' }) + frame('error', { code: 'RATE_LIMITED', retryable: true, message_key: 'err.rate_limited', message: 'SECRET' })).response);
        fireEvent.click(screen.getByRole('button', { name: 'Death list' }));
        await screen.findByText('Too many requests. Please try again later.');
        expect(screen.getByText('partial')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByText('Evidence answer');
        expect(vi.mocked(trackEvent).mock.calls.filter(([e]) => e === 'followup_clicked')).toHaveLength(1);
    });
    it('cancels old followup on language change and drops stale chunks', async () => {
        page();
        await ready();
        const gated = response('', true);
        fetcher.mockResolvedValueOnce(gated.response);
        fireEvent.click(screen.getByRole('button', { name: 'Death list' }));
        await flush();
        const signal = fetcher.mock.calls.at(-1)![1].signal;
        fireEvent.click(screen.getByText('Switch language'));
        fireEvent.click(await screen.findByRole('button', { name: '分享' }));
        await screen.findByText('复制 JSON');
        expect(signal.aborted).toBe(true);
        expect(screen.queryByText('Death list', { selector: 'p' })).toBeNull();
    });
    it('invalid route cancels active review and never requests a bare id', async () => {
        const gated = response('', true);
        fetcher.mockResolvedValue(gated.response);
        page();
        await flush();
        const signal = fetcher.mock.calls[0][1].signal;
        fireEvent.click(screen.getByText('Bare route'));
        await screen.findByText(/That doesn’t look like a match ID\./);
        expect(signal.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('reduced motion buffers streamed chunks and shows the full answer at done', async () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        page();
        await ready();
        const gated = response('', true);
        fetcher.mockResolvedValueOnce(gated.response);
        fireEvent.click(screen.getByRole('button', { name: 'Death list' }));
        await flush();
        gated.push(frame('token', { target: 'answer', delta: 'half' }));
        await flush();
        expect(screen.queryByText('half')).toBeNull();
        gated.push(frame('done', { answer: 'whole answer', state: 'parsed' }));
        await screen.findByText('whole answer');
    });
    it('Jump to latest appears when scrolled up and hides after jumping', async () => {
        const view = page();
        await ready();
        const scroller = view.container.querySelector('.overflow-y-auto')!;
        Object.defineProperties(scroller, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 0, writable: true } });
        fireEvent.scroll(scroller);
        fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
        expect(scroller.scrollTop).toBe(1200);
    });
    it.each([true, false])('keeps marketing off match review even with fake door flag %s', async enabled => {
        flags.fakedoor_v2 = enabled;
        page(); await ready();
        expect(screen.queryByRole('button', { name: 'Notify me' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
        expect(vi.mocked(trackEvent).mock.calls.filter(([e]) => e === 'fakedoor_clicked')).toHaveLength(0);
    });
    it('copies a canonical deep link with hero, claim and language and the exact JSON', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        page('/m/9035042364?hero=pudge&claim=2&lang=en');
        await ready();
        fireEvent.click(screen.getByText('Copy link'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/m/9035042364?hero=pudge&claim=2&lang=en`));
        fireEvent.click(screen.getByText('Copy JSON'));
        await waitFor(() => expect(JSON.parse(writeText.mock.calls[1][0])).toEqual(engine()));
    });
});
