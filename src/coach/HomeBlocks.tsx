import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SafeImg, useLang } from './ui';
import { accessSnippets, agentAsk, agentPrompt, type AccessMode } from './accessSnippets';
import type { Bi } from './types';

const T = {
  howTitle: { en: 'What happens next', zh: '接下来会发生什么', ru: 'Что будет дальше' },
  how: [
    {
      t: { en: 'Pick your hero', zh: '选你玩的英雄', ru: 'Выберите своего героя' },
      d: { en: 'The review is written for that one player.', zh: '复盘只写给这一个人。', ru: 'Разбор пишется для одного игрока.' },
    },
    {
      t: { en: 'The coach reads the replay', zh: '教练看录像', ru: 'Тренер смотрит реплей' },
      d: { en: 'Deaths, ultimates, the fights that turned the game, your items. Three to four minutes.', zh: '阵亡、大招、转折的团战、你的出装。三到四分钟。', ru: 'Смерти, ульты, переломные драки, ваши предметы. Три–четыре минуты.' },
    },
    {
      t: { en: 'You get the review', zh: '拿到复盘', ru: 'Получаете разбор' },
      d: { en: 'One verdict, up to three things that decided the game, and what to do differently next time.', zh: '一句结论，最多三个决定胜负的问题，以及下一把该怎么做。', ru: 'Один вердикт, до трёх главных причин исхода и что сделать иначе в следующей игре.' },
    },
    {
      t: { en: 'Ask about any moment', zh: '对任何时刻追问', ru: 'Спросите о любом моменте' },
      d: { en: '"How should I have played the fight at 30:26?"', zh: '「30:26 那波团我该怎么打？」', ru: '«Как мне стоило сыграть драку на 30:26?»' },
    },
  ] as { t: Bi; d: Bi }[],
  howNote: { en: 'What a replay does not hold — vision, voice chat — the coach says it cannot see.', zh: '录像里没有的（视野、语音），教练会直说看不到。', ru: 'Чего нет в реплее (вижн, голосовой чат), тренер так и скажет.' },
  waysTitle: { en: 'Where to use it', zh: '在哪里用', ru: 'Где пользоваться' },
  copy: { en: 'Copy', zh: '复制', ru: 'Копировать' },
  copied: { en: 'Copied', zh: '已复制', ru: 'Скопировано' },
  promptTitle: { en: 'Or send this to your agent', zh: '或者，把这段话发给你的 Agent', ru: 'Или отправьте это своему ИИ-агенту' },
  clients: { en: 'Your agent', zh: '你用的 Agent', ru: 'Ваш агент' },
  oneLine: { en: 'One line connects it:', zh: '一行接入：', ru: 'Подключение одной строкой:' },
  thenSay: { en: 'Then just say:', zh: '然后说一句：', ru: 'Затем просто напишите:' },
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


/** Web / DSH plugin / Agent (MCP) / CLI / HTTP, each with commands that work as written, plus a prompt for any agent. */
export const AccessModes: React.FC<{ matchId: string; onWeb: () => void }> = ({ matchId, onWeb }) => {
  const { lang, L } = useLang();
  const modes = accessSnippets(matchId);
  // DSH first: it runs on the reader's own model. `#ways-dsh` (the home and match pages' pointers) opens it too.
  const [mode, setMode] = useState<AccessMode>('dsh');
  useEffect(() => {
    const onHash = () => { if (window.location.hash === '#ways-dsh') setMode('dsh'); };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const cur = modes.find((m) => m.mode === mode)!;
  const [clientId, setClientId] = useState(cur.clients?.[0]?.id ?? '');
  const client = cur.clients?.find((c) => c.id === clientId) ?? cur.clients?.[0] ?? null;
  const lines = client ? [client.line] : cur.lines;
  const prompt = agentPrompt(lang);
  return (
    <section className="hm-ways" id="ways" aria-labelledby="hm-ways-title">
      <span id="ways-dsh" className="hm-anchor" aria-hidden="true" />
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
        {cur.clients && (
          <div className="hm-clients" role="group" aria-label={L(T.clients)}>
            <span className="hm-clients-lead">{L(T.oneLine)}</span>
            {cur.clients.map((c) => (
              <button key={c.id} type="button" aria-pressed={client?.id === c.id} className={client?.id === c.id ? 'is-on' : ''} onClick={() => setClientId(c.id)}>
                {L(c.label)}
              </button>
            ))}
          </div>
        )}
        {lines.length > 0 && (
          <div className="hm-code">
            <pre><code>{lines.join('\n')}</code></pre>
            <CopyButton text={lines.join('\n')} label={client ? L(client.label) : L(cur.label)} />
          </div>
        )}
        {client && (client.where || client.install) && (
          <p className="hm-ways-note hm-client-where">
            {client.where && L(client.where)}
            {client.install && <a href={client.install.href} target="_blank" rel="noopener noreferrer">{L(client.install.label)}</a>}
          </p>
        )}
        {client && <p className="hm-say"><span>{L(T.thenSay)}</span> <q>{agentAsk(lang)}</q></p>}
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
