import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { SafeImg, useLang } from './ui';
import { accessSnippets, agentPrompt, type AccessMode } from './accessSnippets';
import type { Bi } from './types';

const T = {
  howTitle: { en: 'What happens next', zh: '接下来会发生什么' },
  how: [
    { t: { en: 'You pick your hero', zh: '选你玩的英雄' }, d: { en: 'The review is written for one player.', zh: '复盘是写给一个人的。' } },
    { t: { en: 'The coach watches the replay', zh: '教练看录像' }, d: { en: 'Every death, every ultimate, the fights that turned the game, your build. Two to three minutes.', zh: '每次阵亡、每个大招、转折的团战、你的出装。两到三分钟。' } },
    { t: { en: 'You get the review', zh: '拿到复盘' }, d: { en: 'One verdict, at most three things that decided it — each with the replay record behind it — and what to change next game.', zh: '一句结论，最多三个决定胜负的问题，每条都能点开对应的录像记录，再加下一把该改什么。' } },
    { t: { en: 'Ask anything', zh: '想问就问' }, d: { en: '"How should I have played the fight at 30:26?" The coach goes back to the replay before answering.', zh: '「30:26 那波团我该怎么打？」教练会回到录像里查了再答。' } },
  ] as { t: Bi; d: Bi }[],
  howNote: { en: 'Times and numbers are checked against the replay. What a replay cannot show — vision, voice chat — the coach says it cannot see.', zh: '时间点和数字都和录像核对过。录像里没有的——视野、语音——教练会直说看不到。' },
  waysTitle: { en: 'Four ways to use it', zh: '四种用法' },
  copy: { en: 'Copy', zh: '复制' },
  copied: { en: 'Copied', zh: '已复制' },
  promptTitle: { en: 'Or send this to your agent', zh: '或者，把这段话发给你的 Agent' },
};

/**
 * The first screen's second half: what happens after you paste a match, in
 * the same four steps the match page shows while it works. No sample numbers:
 * a review is about one real game, so the page shows the shape, not a fake.
 */
export const HowItWorks: React.FC = () => {
  const { L } = useLang();
  return (
    <section className="hm-how" aria-labelledby="hm-how-title">
      <h2 id="hm-how-title">{L(T.howTitle)}</h2>
      <ol className="hm-how-steps">
        {T.how.map((step, i) => (
          <li key={i}>
            <span className="hm-how-dot" aria-hidden="true" />
            <div><strong>{L(step.t)}</strong><p>{L(step.d)}</p></div>
          </li>
        ))}
      </ol>
      <p className="hm-how-note">{L(T.howNote)}</p>
    </section>
  );
};

/** Copy text to the clipboard; resolves false when the browser refuses. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const { L } = useLang();
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="hm-copy" aria-label={`${L(T.copy)} ${label}`}
      onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1600); } }}>
      {done ? L(T.copied) : L(T.copy)}
    </button>
  );
};


/** Web / Agent (MCP) / CLI / HTTP, each with commands that work as written, plus a prompt for any agent. */
export const AccessModes: React.FC<{ matchId: string; onWeb: () => void }> = ({ matchId, onWeb }) => {
  const { lang, L } = useLang();
  const modes = accessSnippets(matchId);
  const [mode, setMode] = useState<AccessMode>('mcp');
  const cur = modes.find((m) => m.mode === mode)!;
  const prompt = agentPrompt(lang);
  return (
    <section className="hm-ways" aria-labelledby="hm-ways-title">
      <h2 id="hm-ways-title">{L(T.waysTitle)}</h2>
      <div className="hm-ways-tabs" role="tablist" aria-label={L(T.waysTitle)}>
        {modes.map((m) => (
          <button key={m.mode} type="button" role="tab" aria-selected={mode === m.mode} className={mode === m.mode ? 'is-on' : ''}
            onClick={() => { setMode(m.mode); if (m.mode === 'web') onWeb(); }}>
            {L(m.label)}
          </button>
        ))}
      </div>
      <div className="hm-ways-panel" role="tabpanel">
        {cur.lines.length > 0 && (
          <div className="hm-code">
            <pre><code>{cur.lines.join('\n')}</code></pre>
            <CopyButton text={cur.lines.join('\n')} label={L(cur.label)} />
          </div>
        )}
        <p className="hm-ways-note">{L(cur.note)}{cur.links && <> {cur.links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}</>}</p>
      </div>
      <div className="hm-prompt">
        <h3>{L(T.promptTitle)}</h3>
        <div className="hm-code">
          <pre><code>{prompt}</code></pre>
          <CopyButton text={prompt} label={L(T.promptTitle)} />
        </div>
      </div>
    </section>
  );
};
