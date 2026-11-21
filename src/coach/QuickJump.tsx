import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { parseMatchInput } from '../v2/parseMatchInput';
import { parseAccountInput, rememberedAccount } from './accountInput';
import type { Bi } from './types';
import { useLang } from './ui';

export type SmartInput =
  | { kind: 'empty' }
  | { kind: 'match'; id: string }
  | { kind: 'account'; id: string }
  | { kind: 'vanity' }
  | { kind: 'invalid' };

/**
 * Unambiguously classifies a single pasted string into a match or Steam account.
 * Pure digits within match-id range resolve as a match; 17-digit SteamID64,
 * [U:1:n] and Steam/OpenDota/Dotabuff/STRATZ player links resolve as an account.
 */
export function detectSmartInput(raw: string): SmartInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  const matchId = parseMatchInput(trimmed);
  if (matchId) return { kind: 'match', id: matchId };
  const acct = parseAccountInput(trimmed);
  if (acct.ok) return { kind: 'account', id: acct.accountId };
  if (acct.reason === 'vanity') return { kind: 'vanity' };
  return { kind: 'invalid' };
}

const T = {
  trigger: { en: 'Jump to match or player', zh: '查比赛 / 好友码' },
  title: { en: 'Open another match or player', zh: '打开另一场比赛或玩家' },
  close: { en: 'Close', zh: '关闭' },
  matchTab: { en: 'Match ID / URL', zh: '比赛 ID / 链接' },
  accountTab: { en: 'Steam friend code', zh: 'Steam 好友代码' },
  matchPlaceholder: { en: 'Match ID or OpenDota / Dotabuff / STRATZ link', zh: '比赛 ID，或 OpenDota / Dotabuff / STRATZ 链接' },
  accountPlaceholder: { en: 'Friend code, SteamID64 or profile link', zh: '好友代码、SteamID64 或个人资料链接' },
  goMatch: { en: 'Open review', zh: '打开复盘' },
  goAccount: { en: 'Show recent games', zh: '查看最近比赛' },
  detectedMatch: { en: 'Match #{id}', zh: '识别为比赛 #{id}' },
  detectedAccount: { en: 'Steam account {id}', zh: '识别为 Steam 账号 {id}' },
  invalidMatch: { en: 'That does not look like a match ID or profile link.', zh: '这看起来不是比赛 ID 或个人资料链接。' },
  invalidAccount: { en: 'That is not a friend code. Open your Steam or Dota 2 profile to find the number under your name.', zh: '这不是好友代码。请在 Dota 2 或 Steam 个人资料里查看名字下面的那串数字。' },
  vanity: { en: 'Custom Steam URLs can’t be looked up. Paste your friend code or a steamcommunity.com/profiles/… link instead.', zh: '自定义的 Steam 链接没法查询。请改贴好友代码，或 steamcommunity.com/profiles/… 形式的链接。' },
  myGames: { en: 'My recent games', zh: '我的最近比赛' },
  example: { en: 'Example match #9091400302', zh: '示例比赛 #9091400302' },
} satisfies Record<string, Bi>;

/**
 * Global quick-jump trigger + modal dialog (also bound to Cmd/Ctrl+K).
 * Renders no <input> until opened so page-level textbox counts stay clean.
 */
export const QuickJump: React.FC = () => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'match' | 'account'>('match');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const known = rememberedAccount();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setError(null);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open, mode]);

  const detected = mode === 'match' ? detectSmartInput(value) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'account') {
      const r = parseAccountInput(value);
      if (!r.ok) { setError(L(r.reason === 'vanity' ? T.vanity : T.invalidAccount)); return; }
      setOpen(false);
      setValue('');
      navigate(`/p/${r.accountId}?lang=${lang}`);
      return;
    }
    const r = detectSmartInput(value);
    if (r.kind === 'match') {
      setOpen(false);
      setValue('');
      navigate(`/r/${r.id}?lang=${lang}`);
    } else if (r.kind === 'account') {
      setOpen(false);
      setValue('');
      navigate(`/p/${r.id}?lang=${lang}`);
    } else if (r.kind === 'vanity') {
      setError(L(T.vanity));
    } else {
      setError(L(T.invalidMatch));
    }
  };

  return (
    <>
      <button ref={triggerRef} type="button" className="cx-qj-trigger" aria-label={L(T.trigger)} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <span className="cx-qj-icon" aria-hidden="true">⌕</span>
        <span className="cx-qj-label">{L(T.trigger)}</span>
        <kbd className="cx-kbd" aria-hidden="true">⌘K</kbd>
      </button>
      {open && createPortal(
        <div className="cx-modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="cx-modal" role="dialog" aria-modal="true" aria-labelledby="cx-qj-title">
            <div className="cx-modal-head">
              <h2 id="cx-qj-title">{L(T.title)}</h2>
              <button type="button" className="cx-modal-close" onClick={() => setOpen(false)} aria-label={L(T.close)}>✕</button>
            </div>
            <div className="cx-qj-modes" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'match'} onClick={() => { setMode('match'); setError(null); }}>{L(T.matchTab)}</button>
              <button type="button" role="tab" aria-selected={mode === 'account'} onClick={() => { setMode('account'); setError(null); }}>{L(T.accountTab)}</button>
            </div>
            <form className="cx-qj-form" onSubmit={submit}>
              <input
                ref={inputRef}
                value={value}
                inputMode="text"
                placeholder={L(mode === 'match' ? T.matchPlaceholder : T.accountPlaceholder)}
                aria-label={L(mode === 'match' ? T.matchPlaceholder : T.accountPlaceholder)}
                onChange={(e) => { setValue(e.target.value); setError(null); }}
              />
              <button type="submit" className="cx-primary">
                {mode === 'account' || detected?.kind === 'account' ? L(T.goAccount) : L(T.goMatch)}
              </button>
            </form>
            {mode === 'match' && detected?.kind === 'match' && (
              <p className="cx-detect-pill is-match">{L(T.detectedMatch).replace('{id}', detected.id)}</p>
            )}
            {mode === 'match' && detected?.kind === 'account' && (
              <p className="cx-detect-pill is-account">{L(T.detectedAccount).replace('{id}', detected.id)}</p>
            )}
            {error && <p className="cx-err" role="alert">{error}</p>}
            <div className="cx-qj-links">
              {known && (
                <button type="button" className="cx-linkbtn" onClick={() => { setOpen(false); navigate(`/p/${known}?lang=${lang}`); }}>
                  {L(T.myGames)} →
                </button>
              )}
              <button type="button" className="cx-linkbtn" onClick={() => { setOpen(false); navigate(`/r/9091400302?lang=${lang}&p=0`); }}>
                {L(T.example)} →
              </button>
            </div>
          </div>
        </div>,
        // Outside .cx-top: its backdrop-filter makes it the containing block for fixed
        // descendants, so the backdrop would only cover the header. Stay inside .cx for its tokens.
        triggerRef.current?.closest('.cx') ?? document.body,
      )}
    </>
  );
};
