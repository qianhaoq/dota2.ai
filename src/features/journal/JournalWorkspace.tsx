import React, { useCallback, useMemo, useState } from 'react';
import { Download, RotateCcw, X } from 'lucide-react';
import { journalStore, useJournalNotes } from './journalStore';
import type { JournalNote } from '../../coach-ui/types';
import type { Language } from '../../types';

/**
 * 战术笔记 (DESIGN.md §3.7): saved actions, not whole reports — each note
 * keeps its source, trigger, action, check and self-report status. Storage is
 * local; failures degrade to this session's memory; export is user-triggered.
 */
const JournalWorkspace: React.FC<{ lang: Language }> = ({ lang }) => {
  const notes = useJournalNotes();
  const persistent = journalStore.isPersistent();
  const [removedNote, setRemovedNote] = useState<JournalNote | null>(null);

  const t = useMemo(() => ({
    kicker: lang === 'zh' ? 'TACTICAL JOURNAL / 战术笔记' : 'TACTICAL JOURNAL',
    title: lang === 'zh' ? '下一局，只带走一个能执行的动作。' : 'Take exactly one executable action into the next game.',
    hint:
      lang === 'zh'
        ? '保存的是具体触发情境和检查方法，不是泛泛的一句“提高意识”。'
        : 'Saved notes carry a concrete trigger and a check method, never a vague “be more aware”.',
    storageOk: lang === 'zh' ? '保存在当前浏览器 · 可删除' : 'Saved in this browser · deletable',
    storageMemory: lang === 'zh' ? '仅本次会话 · 存储不可用' : 'This session only · storage unavailable',
    export: lang === 'zh' ? '导出笔记' : 'Export notes',
    emptyTitle: lang === 'zh' ? '还没有保存的动作。' : 'No saved actions yet.',
    emptyHint:
      lang === 'zh'
        ? '从一个教学场景开始，选出你下一局准备主动检查的事情。'
        : 'Start from a teaching scenario and pick what you will actively check next game.',
    trigger: lang === 'zh' ? '触发' : 'Trigger',
    action: lang === 'zh' ? '行动' : 'Action',
    check: lang === 'zh' ? '检查' : 'Check',
    done: lang === 'zh' ? '已自我检查' : 'Self-checked',
    todo: lang === 'zh' ? '待练习' : 'To practice',
    markDone: lang === 'zh' ? '标记已自我检查' : 'Mark self-checked',
    markTodo: lang === 'zh' ? '标记待练' : 'Mark to-practice',
    remove: lang === 'zh' ? '移除' : 'Remove',
    undo: lang === 'zh' ? '撤销刚才的移除' : 'Undo last removal',
    source: lang === 'zh' ? '场景' : 'Scene',
    authorityLabel: (authority: JournalNote['authority']) =>
      authority === 'user_report'
        ? lang === 'zh' ? '个人记录' : 'Personal record'
        : lang === 'zh' ? '教学练习' : 'Teaching drill',
    boundary:
      lang === 'zh'
        ? '笔记保存在本机，不上传、不公开；保存不等于训练授权。完成标记是自我报告，不代表已验证提升。'
        : 'Notes stay on this device — never uploaded or shared; saving is not training consent. Done marks are self-reports, not verified gains.',
  }), [lang]);

  const handleExport = useCallback(() => {
    const text = journalStore.exportText(lang);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'dota2-tactical-notes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [lang]);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="max-w-[860px] w-full mx-auto px-[16px] pt-[20px] pb-[24px] min-w-0">
        <div className="v3-eyebrow">{t.kicker}</div>
        <h2 className="v3-display text-[18px] leading-[26px] text-v3-text mt-[4px]">{t.title}</h2>
        <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{t.hint}</p>

        <div className="flex items-center justify-between gap-[12px] mt-[14px] flex-wrap">
          <span className={`v3-tag ${persistent ? '' : 'v3-tag-gap'}`}>
            {persistent ? t.storageOk : t.storageMemory}
          </span>
          <button
            type="button"
            className="v3-btn v3-btn-quiet"
            onClick={handleExport}
            disabled={notes.length === 0}
          >
            <Download size={14} />
            {t.export}
          </button>
        </div>

        {notes.length === 0 ? (
          <div className="v3-panel mt-[12px] px-[16px] py-[24px] text-center">
            <p className="text-[14px] text-v3-text">{t.emptyTitle}</p>
            <p className="text-[12px] text-v3-muted mt-[4px]">{t.emptyHint}</p>
          </div>
        ) : (
          <div className="mt-[12px] space-y-[10px]">
            {notes.map((note) => (
              <article
                key={note.key}
                className={`v3-panel px-[16px] py-[14px] ${note.done ? 'opacity-70' : ''}`}
              >
                <div className="flex items-start justify-between gap-[12px] min-w-0">
                  <h3 className="text-[14px] leading-[22px] text-v3-text font-medium min-w-0">{note.title}</h3>
                  <span className="v3-tag v3-tag-demo flex-shrink-0">
                    {t.authorityLabel(note.authority)} · {note.done ? t.done : t.todo}
                  </span>
                </div>
                <dl className="mt-[10px] space-y-[6px]">
                  {([
                    [t.trigger, note.trigger],
                    [t.action, note.action],
                    [t.check, note.check],
                  ] as Array<[string, string]>).map(([label, value]) => (
                    <div key={label} className="flex gap-[10px] min-w-0">
                      <dt className="text-[11px] text-v3-quiet w-[40px] flex-shrink-0">{label}</dt>
                      <dd className="text-[12px] leading-[19px] text-v3-muted min-w-0">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-[12px] flex items-center justify-between gap-[8px] flex-wrap">
                  <span className="text-[10px] text-v3-quiet">
                    {t.source} {note.contextId}
                  </span>
                  <div className="flex items-center gap-[8px]">
                    <button type="button" className="v3-btn v3-btn-quiet" onClick={() => journalStore.toggleDone(note.key)}>
                      {note.done ? t.markTodo : t.markDone}
                    </button>
                    <button
                      type="button"
                      className="v3-btn v3-btn-quiet"
                      aria-label={t.remove}
                      onClick={() => {
                        const removed = journalStore.removeNote(note.key);
                        setRemovedNote(removed);
                      }}
                    >
                      <X size={14} />
                      {t.remove}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {removedNote && (
          <button
            type="button"
            className="v3-btn v3-btn-quiet mt-[10px]"
            onClick={() => {
              journalStore.restoreNote(removedNote);
              setRemovedNote(null);
            }}
          >
            <RotateCcw size={14} />
            {t.undo}
          </button>
        )}

        <p className="mt-[14px] text-[11px] leading-[18px] text-v3-quiet border border-v3-line rounded-[4px] px-[12px] py-[10px]">
          {t.boundary}
        </p>
      </div>
    </div>
  );
};

export default JournalWorkspace;
