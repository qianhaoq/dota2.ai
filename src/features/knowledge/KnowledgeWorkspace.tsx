import React from 'react';
import HeroHub from '../../components/HeroHub';
import type { Language } from '../../types';

/**
 * 英雄图鉴 as KnowledgeLens (DESIGN.md §3.6): a context reference layer. The
 * hub keeps its own fetch and stays mounted in the shell, so opening a hero
 * detail never unloads review sessions, drafts or training state in other
 * workspaces.
 */
const KnowledgeWorkspace: React.FC<{ lang: Language }> = ({ lang }) => {
  const t = {
    kicker: lang === 'zh' ? 'HERO CODEX / 英雄图鉴' : 'HERO CODEX',
    title: lang === 'zh' ? '资料应该回答“怎么用”，不只回答“是多少”。' : 'Reference should answer “how to use”, not just “how much”.',
    hint:
      lang === 'zh'
        ? '中文/英文/别名搜索；技能与属性缺失时显示暂无资料，不补编。查阅结束，回到原来的局面。'
        : 'Search by CN/EN/alias; missing fields stay “no data” instead of invented. Return to your task when done.',
  };
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-shrink-0 max-w-[860px] w-full mx-auto px-[16px] pt-[16px] min-w-0">
        <div className="v3-eyebrow">{t.kicker}</div>
        <h2 className="v3-display text-[16px] leading-[24px] text-v3-text mt-[4px]">{t.title}</h2>
        <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{t.hint}</p>
      </div>
      {/* HeroHub owns its height and scrolling, exactly as it did under the old shell. */}
      <div className="flex-1 min-h-0 min-w-0">
        <HeroHub lang={lang} />
      </div>
    </div>
  );
};

export default KnowledgeWorkspace;
