// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useReadyCallback } from './readyCallback';

const sent: any[] = [];
const read = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(b); });
const events = async () => (await Promise.all(sent)).filter((e) => e.event === 'ready_callback').map((e) => e.props.kind);

let hidden = false;
const shown: { title: string; opts: any; n: any }[] = [];
function stubNotification(permission: NotificationPermission, answer: NotificationPermission = 'granted') {
  class N { onclick: (() => void) | null = null; close = vi.fn(); static permission = permission; static requestPermission = vi.fn(async () => { N.permission = answer; return answer; }); constructor(title: string, opts: any) { shown.push({ title, opts, n: this }); } }
  (window as any).Notification = N;
  return N;
}
const setHidden = (h: boolean) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  (navigator as any).sendBeacon = (_u: string, b: Blob) => { sent.push(read(b).then((t) => JSON.parse(t))); return true; };
  document.title = 'dota2.ai';
  window.focus = vi.fn();
});
afterEach(() => { cleanup(); hidden = false; sent.length = 0; shown.length = 0; delete (window as any).Notification; delete (navigator as any).sendBeacon; });

type P = { working: boolean; ready: boolean; step?: number; selection?: string };
const Harness: React.FC<P> = ({ working, ready, step = 2, selection = '1|beastmaster|zh|' }) => {
  const { button } = useReadyCallback({ matchId: '9100904020', selection, working, step, ready, lang: 'zh', heroName: '兽王', verdict: '咆哮没有留给幻影刺客。' });
  return <div>{button}</div>;
};

describe('bringing the reader back when the review is ready', () => {
  it('the wait is in the tab title; a reader away when it comes sees "ready" there until they look, and is counted as back', async () => {
    const r = render(<Harness working ready={false} step={1} />);
    expect(document.title).toBe('(2/4) 正在复盘 · 兽王 — dota2.ai');
    act(() => setHidden(true));
    r.rerender(<Harness working={false} ready />);
    expect(document.title).toBe('✓ 复盘好了 · 兽王 — dota2.ai');
    act(() => setHidden(false));
    expect(document.title).toBe('dota2.ai');
    expect(await events()).toEqual(['returned']);
  });

  it('a reader still on the tab when it comes gets the page\'s own title back, and no "returned"', async () => {
    const r = render(<Harness working ready={false} />);
    r.rerender(<Harness working={false} ready />);
    expect(document.title).toBe('dota2.ai');
    expect(await events()).toEqual([]);
  });

  it('asked for, allowed: a notification with the verdict when the review comes while away; clicking it is counted', async () => {
    stubNotification('default', 'granted');
    const r = render(<Harness working ready={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好了通知我' })); });
    expect(screen.getByText('好了会通知你，可以先去干别的。')).toBeTruthy();
    act(() => setHidden(true));
    r.rerender(<Harness working={false} ready />);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: '兽王 的复盘好了', opts: { body: '咆哮没有留给幻影刺客。', tag: '1|beastmaster|zh|' } });
    act(() => { shown[0].n.onclick(); });
    expect(await events()).toEqual(['asked', 'granted', 'shown', 'clicked']);
  });

  it('refused: says the title will tell instead; no notification is ever made', async () => {
    stubNotification('default', 'denied');
    const r = render(<Harness working ready={false} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好了通知我' })); });
    expect(screen.getByText(/浏览器拦截了通知/)).toBeTruthy();
    act(() => setHidden(true));
    r.rerender(<Harness working={false} ready />);
    expect(shown).toHaveLength(0);
    expect(await events()).toEqual(['asked', 'denied']);
  });

  it('a notification asked for one review is not sent for another; no button where the browser has none', async () => {
    stubNotification('granted');
    const r = render(<Harness working ready={false} selection="1|beastmaster|zh|" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '好了通知我' })); });
    act(() => setHidden(true));
    r.rerender(<Harness working ready={false} selection="1|axe|zh|" />);
    r.rerender(<Harness working={false} ready selection="1|axe|zh|" />);
    expect(shown).toHaveLength(0);
    cleanup(); delete (window as any).Notification;
    render(<Harness working ready={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
