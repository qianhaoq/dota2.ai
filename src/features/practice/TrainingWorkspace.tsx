import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DecisionFork, EvidenceLens, PracticeCommit } from '../../coach-ui/components';
import { answerEvent, applyPatch, beginRun, finishRun, stopRun, switchContext, createState } from '../../coach-ui/runtime';
import type { CoachAnswerValue, CoachRuntimeState } from '../../coach-ui/types';
import { MentorPicker } from '../../components/coach';
import { useHeroes } from '../../app/useHeroes';
import { journalStore, useJournalNotes } from '../journal/journalStore';
import { heroDisplayName } from '../../utils/practiceContext';
import type { Hero, Language } from '../../types';

export interface TrainingWorkspaceProps {
  lang: Language;
  onNoteSaved: (toast: string) => void;
}

interface DrillVariant {
  key: string;
  situation: string;
  options: Array<{ label: string; need: string; cost: string }>;
  reveal: string;
  trigger: string;
}

/**
 * 英雄修炼 (DESIGN.md §3.5): freeze the situation → hide the answer → the
 * player commits → reveal conditions and costs → switch variant → save an
 * action. Scenarios without real replay data are labeled teaching situations
 * and never pose as this player's actual mistake.
 *
 * State independence (DESIGN.md §2): mentorId, practiceHeroId and
 * focusPlayerSlot are separate concepts — here only practiceHeroId is owned;
 * picking one never touches review perspective or mentor identity.
 */
const TrainingWorkspace: React.FC<TrainingWorkspaceProps> = ({ lang, onNoteSaved }) => {
  const { heroes, isLoading } = useHeroes(lang);
  const [practiceHero, setPracticeHero] = useState<Hero | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [variantIndex, setVariantIndex] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [run, setRun] = useState<CoachRuntimeState>(() => createState('training-free'));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localEventIdRef = useRef(0);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const t = useMemo(() => {
    const variants: DrillVariant[] = [
      {
        key: 'missing-info',
        situation: lang === 'zh' ? '关键对手未出现，队友正在靠近。' : 'The key opponent is missing; teammates are moving in.',
        options:
          lang === 'zh'
            ? [
                { label: '等队友明确发起后，再选入口', need: '需要知道队友是否准备先手。', cost: '代价：可能错过队友节奏，入口窗口更短。' },
                { label: '立即独自接近，制造压力', need: '需要说明自己如何撤出或获得接应。', cost: '代价：可能提前暴露，被反手留住。' },
                { label: '先补一个信息，再决定', need: '需要指出哪个信息会改变决定。', cost: '代价：多花几秒，可能放走当前窗口。' },
              ]
            : [
                { label: 'Wait for clear initiation, then enter', need: 'You must know whether teammates are ready to go.', cost: 'Cost: you may miss their tempo; a shorter entry window.' },
                { label: 'Approach alone now, apply pressure', need: 'You must explain your exit or backup.', cost: 'Cost: early exposure; you can get caught by the counter-engage.' },
                { label: 'Buy one piece of information first', need: 'You must name the info that changes the call.', cost: 'Cost: seconds spent; the current window may close.' },
              ],
        reveal:
          lang === 'zh'
            ? '缺少哪个条件时，这个选择就不再成立？先说出代价，再决定是否行动。'
            : 'Under which missing condition does your pick stop working? State the cost before committing.',
        trigger: lang === 'zh' ? '准备跟进队友或独自靠近战场前。' : 'Before following teammates in or approaching alone.',
      },
      {
        key: 'resource-window',
        situation: lang === 'zh' ? '你攒出一笔关键预算，兵线正压在对手塔前。' : 'You just banked key gold; the wave is on their tower.',
        options:
          lang === 'zh'
            ? [
                { label: '先推进消耗塔', need: '需要确认对手的回防速度。', cost: '代价：暴露在反击视野内，撤退路线更长。' },
                { label: '转身清理附近资源', need: '需要确认这波兵线不会白给。', cost: '代价：塔下压力立即消失，对手获得喘息。' },
                { label: '先补信息再决定', need: '需要指出等什么信息、等多久。', cost: '代价：窗口期内对手可能先动。' },
              ]
            : [
                { label: 'Push and chip the tower', need: 'You must confirm their rotation speed.', cost: 'Cost: exposed in their vision; a longer retreat.' },
                { label: 'Turn to nearby farm', need: 'You must confirm the wave is not lost for free.', cost: 'Cost: tower pressure ends; they recover.' },
                { label: 'Buy information first', need: 'You must say what you wait for, and how long.', cost: 'Cost: they may move first inside your window.' },
              ],
        reveal:
          lang === 'zh'
            ? '这笔资源的用途取决于下一个目标；说清你要交换什么，再比较两条路线。'
            : 'This gold is defined by the next objective; state what you are trading for, then compare routes.',
        trigger: lang === 'zh' ? '攒出关键资源、面对多个可行目标时。' : 'When holding key resources with several viable objectives.',
      },
    ];
    return {
      kicker: lang === 'zh' ? 'HERO TRAINING / 英雄修炼' : 'HERO TRAINING',
      title: lang === 'zh' ? '先做决定，再看教练怎么拆解。' : 'Decide first; the breakdown comes after.',
      hint:
        lang === 'zh'
          ? '教学情境不计真实段位，也不以一次点击证明能力提升。'
          : 'Teaching scenarios carry no rank and no click proves improvement.',
      demoTag: lang === 'zh' ? '教学情境 · 非真实比赛' : 'Teaching scenario',
      questionLabel: lang === 'zh' ? '你掌握的信息不完整。下一步，你会先做什么？' : 'Your information is incomplete. What do you do first?',
      revealBtn: lang === 'zh' ? '确认判断 · 看拆解 →' : 'Commit · see the breakdown →',
      stop: lang === 'zh' ? '停止生成' : 'Stop',
      assembling: lang === 'zh' ? '正在装配讲解…' : 'Assembling the breakdown…',
      commentaryTitle: lang === 'zh' ? '教练点评 · 条件练习，不是唯一正确答案' : 'Coach notes — conditional practice, not the one right answer',
      nextVariant: lang === 'zh' ? '换一个情境 ↻' : 'Next scenario ↻',
      retry: lang === 'zh' ? '再判断一次' : 'Run it again',
      practiceContext: lang === 'zh' ? '练习上下文' : 'PRACTICE CONTEXT',
      practiceHeroLabel: lang === 'zh' ? '练习英雄' : 'Practice hero',
      pickHero: lang === 'zh' ? '选择练习英雄' : 'Pick a practice hero',
      independence:
        lang === 'zh'
          ? '教练身份、练习英雄、比赛中的视角是三个独立状态；这里只改练习英雄。'
          : 'Mentor, practice hero and match perspective are three separate states; only the practice hero changes here.',
      evidence: [
        {
          authority: 'demo' as const,
          label: lang === 'zh' ? '教学设定' : 'Demo',
          text:
            lang === 'zh'
              ? '本情境为教学编写，没有读取你的真实对局，不能冒充你上一局的失误。'
              : 'This scenario is written for teaching; it reads none of your real matches and never poses as your last game.',
        },
        {
          authority: 'user_report' as const,
          label: lang === 'zh' ? '个人回忆' : 'User report',
          text:
            lang === 'zh'
              ? '你的选择只作为个人记录保留，不会改写任何比赛事实。'
              : 'Your choice is kept as a personal record and never rewrites match facts.',
        },
        {
          authority: 'gap' as const,
          label: lang === 'zh' ? '数据缺口' : 'Gap',
          text:
            lang === 'zh'
              ? '跨局验证需要角色、补丁与样本控制；本页没有自动成长分，完成标记只是自我报告。'
              : 'Cross-game verification needs role, patch and sample control; no growth score here — completing is self-report.',
        },
      ],
      commitTitle: lang === 'zh' ? '信息不完整时，先说清一个缺口' : 'Name one gap before acting on incomplete info',
      check: lang === 'zh' ? '赛后回想：这次行动前是否主动确认？不以击杀或胜负单独判定。' : 'After the game: did you actively confirm before acting? Not judged by kills or result alone.',
      actionPrefix: lang === 'zh' ? '说出' : 'Name',
      memoryQuestion:
        lang === 'zh'
          ? '上一局遇到类似局面时，你当时主动确认过关键信息吗？'
          : 'Last time you hit a similar spot, did you actively confirm the key info?',
      memoryOptions: [
        { value: 'seen' as const, label: lang === 'zh' ? '确认过' : 'Confirmed' },
        { value: 'unseen' as const, label: lang === 'zh' ? '没确认' : 'Did not' },
        { value: 'unknown' as const, label: lang === 'zh' ? '记不清' : "Can't recall" },
      ],
      memorySaved:
        lang === 'zh'
          ? '你的补充已保留为个人回忆（user_report），不会改写任何比赛事实。'
          : 'Your answer is kept as a personal memory (user_report); it never rewrites match facts.',
      variants,
    };
  }, [lang]);

  const variant = t.variants[variantIndex] ?? t.variants[0];
  const practiceHeroName = practiceHero ? heroDisplayName(practiceHero, lang) : null;
  const contextId = `training-${practiceHero?.id ?? 'free'}`;
  const journalNotes = useJournalNotes();

  // Switching the practice hero switches context; it never restarts a mentor or a review.
  useEffect(() => {
    setRun((prev) => (prev.contextId === contextId ? prev : switchContext(prev, contextId)));
  }, [contextId]);

  const resetDrill = (nextVariant: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setRun((prev) => stopRun(prev));
    setVariantIndex(nextVariant);
    setChoice(null);
    setRevealed(false);
  };

  /** Reveal runs through the coach-ui runtime: beginRun → patch DecisionFork → finishRun. */
  const handleReveal = () => {
    if (choice === null || run.busy) return;
    const started = beginRun(run);
    setRun(started);
    setRevealed(true);
    const runId = started.runId;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setRun((prev) => {
        const patched = applyPatch(prev, {
          contextId: prev.contextId,
          contextRevision: prev.contextRevision,
          runId,
          surface: {
            id: 'decision',
            component: 'DecisionFork',
            revision: (prev.surfaces.decision?.revision ?? 0) + 1,
            presentation: 'demo',
            title: variant.reveal,
          },
        });
        return finishRun(patched, runId);
      });
    }, 700);
  };

  const handleStop = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setRun((prev) => stopRun(prev));
  };

  /** Player memory lands as user_report via the runtime answer event (deduped, context-bound). */
  const handleMemoryAnswer = (value: CoachAnswerValue) => {
    setRun((prev) =>
      answerEvent(prev, {
        id: globalThis.crypto?.randomUUID?.() ?? `training-event-${++localEventIdRef.current}`,
        action: 'answer',
        contextId: prev.contextId,
        contextRevision: prev.contextRevision,
        value,
      }),
    );
  };

  const surfaceTitle = run.surfaces.decision?.title;
  const forkTitle = run.busy ? t.assembling : (revealed && surfaceTitle ? surfaceTitle : t.questionLabel);
  const chosen = choice !== null ? variant.options[choice] : null;
  const savedToast = lang === 'zh' ? '已保存到战术笔记' : 'Saved to the tactical journal';

  const handleSave = () => {
    if (!chosen) return;
    const status = journalStore.addNote({
      key: `drill-${practiceHero?.id ?? 'free'}-${variant.key}`,
      title: t.commitTitle,
      trigger: variant.trigger,
      action: `${t.actionPrefix}${chosen.need}`,
      check: t.check,
      contextId,
      authority: 'demo',
    });
    if (status === 'invalid') return;
    onNoteSaved(savedToast);
  };

  const noteSaved = journalNotes.some((n) => n.key === `drill-${practiceHero?.id ?? 'free'}-${variant.key}`);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="max-w-[860px] w-full mx-auto px-[16px] pt-[20px] pb-[24px] min-w-0 space-y-[12px]">
        <div>
          <div className="v3-eyebrow">{t.kicker}</div>
          <h2 className="v3-display text-[18px] leading-[26px] text-v3-text mt-[4px]">{t.title}</h2>
          <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{t.hint}</p>
        </div>

        <section className="v3-panel px-[16px] py-[14px]">
          <div className="flex items-start justify-between gap-[12px] min-w-0">
            <div className="min-w-0">
              <div className="v3-eyebrow mb-[4px]">ONE SITUATION / ONE DECISION</div>
              <h3 className="text-[14px] leading-[22px] text-v3-text font-medium">{variant.situation}</h3>
            </div>
            <span className="v3-tag v3-tag-demo flex-shrink-0">{t.demoTag}</span>
          </div>
        </section>

        <DecisionFork
          lang={lang}
          title={forkTitle}
          options={variant.options.map((option, index) => ({ value: String(index), label: option.label }))}
          selected={choice !== null ? String(choice) : null}
          onSelect={(value) => {
            setChoice(Number(value));
            setRevealed(false);
            handleStop();
          }}
          footnote={
            lang === 'zh'
              ? '先选一次，不让答案出现在问题前面；你的选择按个人回忆保留。'
              : 'Decide before the answer shows; your choice is kept as a personal record.'
          }
          busy={run.busy}
        >
          {run.busy ? (
            <button type="button" className="v3-btn v3-btn-primary" onClick={handleStop}>
              {t.stop}
            </button>
          ) : revealed && surfaceTitle ? (
            <>
              <span className="text-[11px] text-v3-quiet">{t.commentaryTitle}</span>
              {chosen && (
                <p className="text-[12px] leading-[19px] text-v3-muted basis-full">{chosen.cost}</p>
              )}
            </>
          ) : (
            <button
              type="button"
              className="v3-btn v3-btn-primary"
              onClick={handleReveal}
              disabled={choice === null}
            >
              {t.revealBtn}
            </button>
          )}
        </DecisionFork>

        {revealed && !run.busy && surfaceTitle && (
          <section className="v3-panel px-[16px] py-[14px]" aria-label={lang === 'zh' ? '个人回忆' : 'Personal memory'}>
            <h3 className="text-[13px] leading-[21px] text-v3-text font-medium">{t.memoryQuestion}</h3>
            <div className="flex flex-wrap gap-[8px] mt-[10px]">
              {t.memoryOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={run.answers.visibility?.value === option.value}
                  onClick={() => handleMemoryAnswer(option.value)}
                  className={`v3-btn ${run.answers.visibility?.value === option.value ? 'v3-btn-primary' : ''}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {run.answers.visibility && (
              <p className="mt-[10px] text-[11px] leading-[18px] text-v3-quiet" role="status">
                {t.memorySaved}
              </p>
            )}
          </section>
        )}

        {revealed && !run.busy && surfaceTitle && chosen && (
          <PracticeCommit
            lang={lang}
            trigger={variant.trigger}
            action={`${t.actionPrefix}${chosen.need}`}
            check={t.check}
            onSave={handleSave}
            saved={noteSaved}
          />
        )}

        {revealed && !run.busy && surfaceTitle && (
          <div className="flex flex-wrap gap-[8px]">
            <button
              type="button"
              className="v3-btn"
              onClick={() => resetDrill((variantIndex + 1) % t.variants.length)}
            >
              {t.nextVariant}
            </button>
            <button type="button" className="v3-btn v3-btn-quiet" onClick={() => resetDrill(variantIndex)}>
              {t.retry}
            </button>
          </div>
        )}

        <EvidenceLens lang={lang} blocks={t.evidence} />

        <section className="v3-panel px-[16px] py-[14px]">
          <div className="v3-eyebrow mb-[8px]">{t.practiceContext}</div>
          <p className="text-[12px] leading-[19px] text-v3-muted">{t.independence}</p>
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="v3-btn mt-[10px]"
            aria-label={t.pickHero}
          >
            {practiceHero ? (
              <>
                {practiceHero.img && (
                  <img src={practiceHero.img} alt="" aria-hidden="true" className="w-[24px] h-[24px] rounded-[4px] object-cover" loading="lazy" />
                )}
                <span>{practiceHeroName}</span>
              </>
            ) : (
              <span>{t.pickHero}</span>
            )}
          </button>
        </section>
      </div>

      <MentorPicker
        lang={lang}
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        allHeroes={heroes}
        isLoading={isLoading}
        currentMentor={practiceHero}
        onSelectMentor={(hero) => {
          setPracticeHero(hero);
          resetDrill(variantIndex);
        }}
        onDismissMentor={() => {
          setPracticeHero(null);
          resetDrill(variantIndex);
        }}
      />
    </div>
  );
};

export default TrainingWorkspace;
