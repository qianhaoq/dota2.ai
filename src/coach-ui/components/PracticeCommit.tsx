import React from 'react';
import type { Language } from '../../types';

export interface PracticeCommitProps {
  lang: Language;
  /** What will be saved: trigger + action + check, not a whole report. */
  trigger: string;
  action: string;
  check: string;
  onSave: () => void;
  /** After save the primary action becomes an undo-safe confirmation. */
  saved?: boolean;
  disabled?: boolean;
}

/**
 * PracticeCommit (catalog: dota-coach-ui/1) — 保存、检查、完成、撤销。
 * Selecting a route is only a preference; an explicit "加入计划" saves the
 * action. Completing it later is self-report, never measured progress.
 */
const PracticeCommit: React.FC<PracticeCommitProps> = ({
  lang,
  trigger,
  action,
  check,
  onSave,
  saved = false,
  disabled = false,
}) => {
  const t = {
    title: lang === 'zh' ? '带进下一局' : 'Commit to next game',
    trigger: lang === 'zh' ? '触发情境' : 'Trigger',
    action: lang === 'zh' ? '行为' : 'Action',
    check: lang === 'zh' ? '检查方法' : 'Check',
    save: lang === 'zh' ? '加入计划 →' : 'Add to plan →',
    saved: lang === 'zh' ? '已在战术笔记中' : 'Saved to journal',
    boundary:
      lang === 'zh'
        ? '保存的是动作，不是结论。完成后标记为自我检查，不代表已验证提升。'
        : 'Saves an action, not a verdict. Completing it is self-check, not verified progress.',
  };
  const rows: Array<[string, string]> = [
    [t.trigger, trigger],
    [t.action, action],
    [t.check, check],
  ];
  return (
    <section className="v3-panel px-[16px] py-[14px]" aria-label={t.title}>
      <div className="v3-eyebrow mb-[10px]">PRACTICE COMMIT</div>
      <dl className="space-y-[8px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-[12px] min-w-0">
            <dt className="text-[11px] text-v3-quiet w-[64px] flex-shrink-0">{label}</dt>
            <dd className="text-[12px] leading-[19px] text-v3-muted min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-[12px] flex items-center gap-[12px] flex-wrap">
        <button type="button" className="v3-btn v3-btn-primary" onClick={onSave} disabled={disabled || saved}>
          {saved ? t.saved : t.save}
        </button>
      </div>
      <p className="mt-[10px] text-[11px] leading-[18px] text-v3-quiet">{t.boundary}</p>
    </section>
  );
};

export default PracticeCommit;
