import React, { useEffect, useState } from 'react';
import { useLang } from './ui';
import { accessSnippets, agentAsk, agentPrompt, dshDesktopPrompt, DSH_DOWNLOAD_URL, DSH_PLUGIN_VERSION, DSH_RELEASE_URL, DSH_SETUP, type AccessMode } from './accessSnippets';
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
  waysTitle: { en: 'Where to use it', zh: '在哪里用（推荐 DeepSeek Harness 桌面端）', ru: 'Где пользоваться' },
  copy: { en: 'Copy', zh: '复制', ru: 'Копировать' },
  copied: { en: 'Copied', zh: '已复制', ru: 'Скопировано' },
  promptTitle: { en: 'Or send this to any AI agent', zh: '或者，把这段话发给任意 AI Agent', ru: 'Или отправьте это любому ИИ-агенту' },
  clients: { en: 'Your agent', zh: '你用的 Agent', ru: 'Ваш агент' },
  oneLine: { en: 'One line connects it:', zh: '一行接入：', ru: 'Подключение одной строкой:' },
  thenSay: { en: 'Then just say:', zh: '然后说一句：', ru: 'Затем просто напишите:' },
  dshBadge: { en: 'Recommended · Desktop app · No terminal needed', zh: '推荐 · 桌面客户端 · 全程免敲命令行', ru: 'Рекомендуем · Десктопное приложение · Без терминала' },
  dshPitch: {
    en: 'Run the full dota2.ai coach on your own DeepSeek key — no queue, no daily limit, and your reviews stay private on your computer.',
    zh: '用你自己的 DeepSeek Key 跑完整的 dota2.ai 教练：不排队、不限次，复盘记录和追问都只保存在你自己电脑上。',
    ru: 'Запускайте полного тренера dota2.ai на своём ключе DeepSeek — без очереди и дневного лимита, разборы хранятся локально на вашем компьютере.',
  },
  dshStep1Title: { en: 'Download & open DeepSeek Harness', zh: '下载并打开 DeepSeek Harness 桌面客户端', ru: 'Скачайте и откройте DeepSeek Harness' },
  dshStep1Body: {
    en: 'Install the official desktop app (macOS / Windows — no Node.js or terminal setup). Open it and sign in or enter your DeepSeek API Key.',
    zh: '前往官网下载安装包（支持 macOS / Windows，像普通软件一样安装，无需配置 Node.js）。打开后登录或填入你的 DeepSeek API Key。',
    ru: 'Установите официальное десктопное приложение (macOS / Windows — Node.js не требуется). Откройте его и введите свой DeepSeek API Key.',
  },
  dshStep1Btn: { en: 'Download DeepSeek Harness', zh: '前往官网下载 DeepSeek Harness', ru: 'Скачать DeepSeek Harness' },
  dshStep2Title: { en: 'Send this one install message in DeepSeek Harness', zh: '复制下面这句话，直接发给客户端聊天框', ru: 'Отправьте эту фразу в чат DeepSeek Harness' },
  dshStep2Body: {
    en: 'Paste into the chat box and press Enter — DeepSeek Harness downloads and installs the dota2.ai plugin automatically.',
    zh: '粘贴到 DeepSeek Harness 对话框里回车发送，客户端会自动帮你下载并装好插件。',
    ru: 'Вставьте сообщение в чат и нажмите Enter — DeepSeek Harness сам скачает и установит плагин dota2.ai.',
  },
  dshCopyPrompt: { en: 'install message', zh: '安装指令', ru: 'команду установки' },
  dshStep3Title: { en: 'Open dota2.ai in the sidebar & start reviewing', zh: '在左侧栏打开 dota2.ai，开始复盘', ru: 'Откройте dota2.ai в боковой панели' },
  dshStep3Body: {
    en: 'Reload if prompted, then click dota2.ai in the left sidebar for the full match review page (scoreboard, minimap replay, evidence cards, coach chat) — or just ask in chat:',
    zh: '按提示刷新或重启后，点左侧栏的 dota2.ai 就能进入完整复盘页（记分板、小地图走位回放、录像证据卡、追问教练），也可以直接在聊天框说：',
    ru: 'При необходимости перезагрузите окно и нажмите dota2.ai в левой панели для полной страницы разбора — или просто напишите в чат:',
  },
  dshCliToggle: { en: 'Linux or prefer terminal (dsh web CLI)?', zh: 'Linux 或习惯用命令行安装（dsh web）？', ru: 'Linux или предпочитаете терминал (dsh web CLI)?' },
  dshCliNote: {
    en: 'Needs Node 24.9+. After dsh web starts, enter your DeepSeek key in DSH and open dota2.ai in the sidebar.',
    zh: '需要 Node 24.9+。启动 dsh web 后在 DSH 中填入 DeepSeek Key，再从左侧栏打开 dota2.ai。',
    ru: 'Нужен Node 24.9+. После запуска dsh web введите ключ DeepSeek в DSH и откройте dota2.ai в боковой панели.',
  },
  dshCliCopy: { en: 'DSH CLI commands', zh: 'DSH 命令行安装', ru: 'команды DSH CLI' },
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
        {mode === 'dsh' ? (
          <div className="hm-dsh-guide">
            <p className="hm-dsh-badge">{L(T.dshBadge)}</p>
            <p className="hm-dsh-pitch">{L(T.dshPitch)}</p>
            <ol className="hm-dsh-steps">
              <li>
                <span className="hm-dsh-num" aria-hidden="true">1</span>
                <div className="hm-dsh-step-body">
                  <strong>{L(T.dshStep1Title)}</strong>
                  <p>{L(T.dshStep1Body)}</p>
                  <a href={DSH_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="hm-dsh-btn">
                    {L(T.dshStep1Btn)} · deepseek.com/harness ↗
                  </a>
                </div>
              </li>
              <li>
                <span className="hm-dsh-num" aria-hidden="true">2</span>
                <div className="hm-dsh-step-body">
                  <strong>{L(T.dshStep2Title)}</strong>
                  <p>{L(T.dshStep2Body)}</p>
                  <div className="hm-code">
                    <pre><code>{dshDesktopPrompt(lang)}</code></pre>
                    <CopyButton text={dshDesktopPrompt(lang)} label={L(T.dshCopyPrompt)} />
                  </div>
                </div>
              </li>
              <li>
                <span className="hm-dsh-num" aria-hidden="true">3</span>
                <div className="hm-dsh-step-body">
                  <strong>{L(T.dshStep3Title)}</strong>
                  <p>{L(T.dshStep3Body)}</p>
                  <p className="hm-say"><q>{agentAsk(lang)}</q></p>
                </div>
              </li>
            </ol>
            <details className="hm-dsh-cli">
              <summary>{L(T.dshCliToggle)}</summary>
              <div className="hm-code">
                <pre><code>{DSH_SETUP.join('\n')}</code></pre>
                <CopyButton text={DSH_SETUP.join('\n')} label={L(T.dshCliCopy)} />
              </div>
              <p className="hm-ways-note">
                {L(T.dshCliNote)}{' '}
                <a href={DSH_RELEASE_URL} target="_blank" rel="noopener noreferrer">dsh-v{DSH_PLUGIN_VERSION}</a>
              </p>
            </details>
          </div>
        ) : (
          <>
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
          </>
        )}
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
