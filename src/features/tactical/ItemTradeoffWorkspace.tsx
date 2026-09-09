import React, { useMemo, useState } from 'react';
import { ItemTradeoff, EvidenceLens, PracticeCommit, type EvidenceBlock, type TradeoffRoute } from '../../coach-ui/components';
import { journalStore } from '../journal/journalStore';
import type { Language } from '../../types';

export interface ItemTradeoffWorkspaceProps {
  lang: Language;
  onSaved: () => void;
}

const CONTEXT_ID = 'items-demo';

/**
 * Item tradeoff workspace (DESIGN.md §3.4): compare two abstract routes —
 * survival vs damage — on decision dimensions only. This is a labeled teaching
 * comparison: it does not read the current patch, your economy or your
 * inventory, so it must never pose as a specific in-game recommendation.
 */
const ItemTradeoffWorkspace: React.FC<ItemTradeoffWorkspaceProps> = ({ lang, onSaved }) => {
  const [routeId, setRouteId] = useState<'survive' | 'damage'>('survive');
  const [saved, setSaved] = useState(false);

  const t = useMemo(() => ({
    kicker: lang === 'zh' ? 'ITEM TRADEOFF / 装备取舍' : 'ITEM TRADEOFF',
    title: lang === 'zh' ? '不是推荐六格神装，而是解决眼前的问题。' : 'Not a six-slot wishlist — solve the problem in front of you.',
    hint:
      lang === 'zh'
        ? '这里只比较决策维度；没有读取当前补丁的物品数值，也没有你的本局经济与购买时间线。'
        : 'Decision dimensions only. No current-patch numbers, no live economy or purchase timeline.',
    question: lang === 'zh' ? '这笔资源，优先换生存还是输出？' : 'This gold: survival or damage first?',
    demoLabel: lang === 'zh' ? '教学示例' : 'Demo',
    routes: [
      {
        id: 'survive',
        symbol: '◇',
        title: lang === 'zh' ? '优先生存工具' : 'Survival tools first',
        purpose: lang === 'zh' ? '让你在关键控制下仍然能做完自己的事。' : 'Stay functional through the key disables.',
        premise: lang === 'zh' ? '威胁明确：对面有先手控制或爆发，你的现有手段不够。' : 'The threat is clear: initiation or burst your kit cannot answer.',
        sacrifice: lang === 'zh' ? '延迟输出成型；若队友缺伤害，团战窗口可能更紧。' : 'Slower damage spike; tighter fight windows if the team lacks damage.',
        switchWhen: lang === 'zh' ? '对手关键控制未交或你被针对的假设不成立时。' : 'When the key disables are spent or you are not actually the target.',
      },
      {
        id: 'damage',
        symbol: '✧',
        title: lang === 'zh' ? '优先输出工具' : 'Damage tools first',
        purpose: lang === 'zh' ? '把队友创造的空间兑换成有效伤害。' : 'Convert the space your team creates into real damage.',
        premise: lang === 'zh' ? '有安全输出窗口：队友能先手或接应，你不容易被先秒。' : 'A safe window exists: teammates initiate or follow up; you are hard to burst.',
        sacrifice: lang === 'zh' ? '容错下降；被针对时这笔投入可能整局兑现不了。' : 'Less room for error; if focused, the investment may never pay out.',
        switchWhen: lang === 'zh' ? '你连续在开打前就被击杀或被迫撤退时。' : 'When you keep dying or getting forced out before the fight starts.',
      },
    ] as [TradeoffRoute, TradeoffRoute],
    evidence: [
      {
        authority: 'gap' as const,
        label: lang === 'zh' ? '数据缺口' : 'Gap',
        text:
          lang === 'zh'
            ? '当前经济、已有物品、购买时刻与下一次目标——这些决定“是否太晚”，这里都没有读取。'
            : 'Current gold, owned items, purchase timing and next objective — none are loaded here, yet they decide “too late or not”.',
      },
      {
        authority: 'demo' as const,
        label: lang === 'zh' ? '教学设定' : 'Demo',
        text:
          lang === 'zh'
            ? '两条路线是抽象分支，用于练习取舍，不冒充当前补丁的具体装备推荐。'
            : 'Both routes are abstract branches for practicing tradeoffs, not patch-specific item picks.',
      },
      {
        authority: 'hypothesis' as const,
        label: lang === 'zh' ? '假设' : 'Hypothesis',
        text:
          lang === 'zh'
            ? '“对手的关键控制还没交”是一个假设；先向队友确认，再据此选择。'
            : '“Their key disable is still up” is a hypothesis; confirm it before relying on it.',
      },
    ] as EvidenceBlock[],
    evidenceNote:
      lang === 'zh'
        ? '缺数据就问，不用终局物品伪造购买时间线；你的补充按个人回忆保留，不会升级为事实。'
        : 'Ask for missing data; end-game items never fake a purchase timeline. Your input stays user-report.',
    commitTitle: lang === 'zh' ? '保存这次取舍原则' : 'Save this tradeoff principle',
    trigger:
      lang === 'zh'
        ? '准备把一笔资源投入下一件装备时。'
        : 'When about to commit a chunk of gold to the next item.',
    action:
      routeId === 'survive'
        ? lang === 'zh'
          ? '说出具体威胁、已有应对方式，以及仍然缺失的一个条件。'
          : 'Name the threat, your current answer, and one condition still missing.'
        : lang === 'zh'
          ? '说明输出窗口、可攻击目标，以及投入被浪费的风险。'
          : 'State the damage window, the target, and the risk of a wasted investment.',
    check:
      lang === 'zh'
        ? '赛后核对：这个选择回应了当时的问题吗？不只看最终伤害。'
        : 'After the game: did the choice answer the actual problem? Not just final damage.',
  }), [lang, routeId]);

  const commitKey = `item-${routeId}`;

  const handleSave = () => {
    const status = journalStore.addNote({
      key: commitKey,
      title: t.commitTitle,
      trigger: t.trigger,
      action: t.action,
      check: t.check,
      contextId: CONTEXT_ID,
      authority: 'demo',
    });
    if (status === 'invalid') return;
    setSaved(true);
    onSaved();
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="max-w-[860px] w-full mx-auto px-[16px] pt-[20px] pb-[24px] min-w-0 space-y-[12px]">
        <div>
          <div className="v3-eyebrow">{t.kicker}</div>
          <h2 className="v3-display text-[18px] leading-[26px] text-v3-text mt-[4px]">{t.title}</h2>
          <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{t.hint}</p>
        </div>
        <ItemTradeoff
          lang={lang}
          question={t.question}
          routes={t.routes}
          selectedId={routeId}
          onSelect={(id) => {
            setRouteId(id as 'survive' | 'damage');
            setSaved(false);
          }}
          demoLabel={t.demoLabel}
        />
        <EvidenceLens lang={lang} blocks={t.evidence} note={t.evidenceNote} />
        <PracticeCommit
          lang={lang}
          trigger={t.trigger}
          action={t.action}
          check={t.check}
          onSave={handleSave}
          saved={saved}
        />
      </div>
    </div>
  );
};

export default ItemTradeoffWorkspace;
