import { A2UIAction, A2UIBlock, Language } from '../types';
import type { CoachMessage, CoachSession } from '../components/coach/coachMessage';
import type { MatchFact } from '../types/matchReview';
import { formatObjectiveLabel } from '../../lib/matchReview/objectiveLabels.js';
import { selectTimelineForDisplay } from '../../lib/matchReview/matchFacts.js';

export interface MarkdownSection {
  title?: string;
  markdown: string;
}

/**
 * 按二级标题拆成可独立渲染的卡片段。
 * 流式过程中标题尚未写完时，未闭合段仍会作为最后一块返回。
 */
export function parseMarkdownSections(content: string): MarkdownSection[] {
  if (!content.trim()) return [];

  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  let currentTitle: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    const markdown = currentLines.join('\n').trim();
    if (currentTitle || markdown) {
      sections.push({ title: currentTitle, markdown });
    }
    currentTitle = undefined;
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      currentTitle = line.replace(/^##\s+/, '').trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

function labels(lang: Language) {
  return {
    matchups: lang === 'zh' ? '对位优势' : 'Matchups',
    playbook: lang === 'zh' ? '出装剧本' : 'Item playbook',
    actions: lang === 'zh' ? '推荐选人' : 'Suggested picks',
    tier: lang === 'zh' ? '版本梯队' : 'Patch tier',
    analysis: lang === 'zh' ? '分析' : 'Analysis',
    brief: lang === 'zh' ? '导读' : 'Brief',
    reviewSummary: lang === 'zh' ? '摘要' : 'Summary',
    reviewLanes: lang === 'zh' ? '真实分路' : 'True lanes',
    reviewEconomy: lang === 'zh' ? '经济' : 'Economy',
    reviewTimeline: lang === 'zh' ? '时间线' : 'Timeline',
    reviewPov: lang === 'zh' ? '你的镜头' : 'Your POV',
    reviewHowToWin: lang === 'zh' ? '如何赢' : 'How to win',
    laneInference: lang === 'zh' ? '根据录像站位推断' : 'Inferred from replay positioning',
    lanesUnavailable: lang === 'zh'
      ? '本场暂无可用录像站位数据，无法推断分路。'
      : 'No replay positioning data available; lanes could not be inferred.',
  };
}

function suggestionActions(message: CoachMessage, lang: Language): A2UIAction[] {
  return (message.suggestions || []).slice(0, 6).map((s) => {
    const label = lang === 'zh' ? (s.nameZh || s.name) : (s.nameEn || s.name);
    const roles = lang === 'zh' && s.rolesZh ? s.rolesZh : s.roles;
    return {
      id: `pick-${s.id}`,
      label,
      subtitle: roles?.slice(0, 2).join(' / '),
      meta: s.bestAdvantage && parseFloat(s.bestAdvantage) > 0 ? `+${s.bestAdvantage}%` : undefined,
      heroId: s.id,
    };
  });
}

function reviewSectionBlocks(message: CoachMessage, lang: Language, t: ReturnType<typeof labels>): A2UIBlock[] {
  const fact = message.matchFact as MatchFact | null | undefined;
  if (!fact) return [];

  const blocks: A2UIBlock[] = [];

  const summaryMd = lang === 'zh'
    ? `比赛 ${fact.summary.matchId} · ${fact.summary.durationFormatted} · ${fact.summary.winnerLabelZh}`
    : `Match ${fact.summary.matchId} · ${fact.summary.durationFormatted} · ${fact.summary.winnerLabelEn}`;

  blocks.push({
    id: `${message.id}-review-summary`,
    type: 'review',
    title: t.reviewSummary,
    markdown: summaryMd,
    reviewSection: 'summary',
    matchFact: fact,
  });

  const laneLines = fact.lanes.map((lane) => {
    const label = lang === 'zh' ? lane.laneLabelZh : lane.laneLabelEn;
    const rad = lane.radiantNames.join(' + ');
    const dire = lane.direNames.join(' + ');
    return lang === 'zh'
      ? `${label}：天辉 ${rad} vs 夜魇 ${dire}`
      : `${label}: Radiant ${rad} vs Dire ${dire}`;
  }).join('\n');

  blocks.push({
    id: `${message.id}-review-lanes`,
    type: 'review',
    title: t.reviewLanes,
    markdown: fact.lanes.length > 0 ? laneLines : t.lanesUnavailable,
    reviewSection: 'lanes',
    matchFact: fact,
  });

  const ecoLines = fact.economy.checkpoints.map((cp) => {
    const sign = cp.radiantGoldLead >= 0 ? '+' : '';
    return lang === 'zh'
      ? `- ${cp.minute} 分钟：天辉 ${sign}${cp.radiantGoldLead}`
      : `- ${cp.minute} min: Radiant ${sign}${cp.radiantGoldLead}`;
  }).join('\n');

  blocks.push({
    id: `${message.id}-review-economy`,
    type: 'review',
    title: t.reviewEconomy,
    markdown: ecoLines || (lang === 'zh' ? '暂无经济节点数据' : 'No economy checkpoints'),
    reviewSection: 'economy',
    matchFact: fact,
  });

  const timelineLines = selectTimelineForDisplay(fact.timeline).map((ev) => {
    const min = Math.floor(ev.time / 60);
    const sec = ev.time % 60;
    const label = formatObjectiveLabel(ev, lang);
    return `- ${min}:${String(sec).padStart(2, '0')} ${label}`;
  }).join('\n');

  blocks.push({
    id: `${message.id}-review-timeline`,
    type: 'review',
    title: t.reviewTimeline,
    markdown: timelineLines || (lang === 'zh' ? '暂无时间线' : 'No timeline'),
    reviewSection: 'timeline',
    matchFact: fact,
  });

  if (fact.focusLens) {
    const f = fact.focusLens;
    const laneLine = f.laneGrounded
      ? (lang === 'zh'
        ? `分路：${f.laneLabel}\n对线：${f.opponents.map((o) => o.displayName).join('、') || '—'}${f.nearby.length ? `\n附近：${f.nearby.map((o) => o.displayName).join('、')}` : ''}`
        : `Lane: ${f.laneLabel}\nVs: ${f.opponents.map((o) => o.displayName).join(', ') || '—'}${f.nearby.length ? `\nNearby: ${f.nearby.map((o) => o.displayName).join(', ')}` : ''}`)
      : (lang === 'zh' ? f.laneLabel : f.laneLabel);
    const povMd = lang === 'zh'
      ? `${f.displayName} · KDA ${f.kda} · GPM ${f.gpm}\n${laneLine}`
      : `${f.displayName} · KDA ${f.kda} · GPM ${f.gpm}\n${laneLine}`;

    blocks.push({
      id: `${message.id}-review-pov`,
      type: 'review',
      title: t.reviewPov,
      markdown: povMd,
      reviewSection: 'pov',
      matchFact: fact,
    });
  }

  return blocks;
}

/**
 * 把一条教练消息映射成 A2UI 块。渲染层只吃 blocks，不解析聊天气泡。
 */
export function messageToBlocks(message: CoachMessage, lang: Language = 'zh'): A2UIBlock[] {
  const t = labels(lang);
  const blocks: A2UIBlock[] = [];

  if (message.error) {
    return [];
  }

  if (message.action === 'review' && message.matchFact) {
    blocks.push(...reviewSectionBlocks(message, lang, t));
  }

  const matchups = message.matchupData;
  if (matchups && (matchups.radiantAdvantages.length > 0 || matchups.direAdvantages.length > 0)) {
    blocks.push({
      id: `${message.id}-matchups`,
      type: 'matchups',
      title: t.matchups,
      matchups,
    });
  }

  if (message.playbookData && message.playbookData.length > 0) {
    blocks.push({
      id: `${message.id}-playbook`,
      type: 'section',
      title: t.playbook,
      playbook: message.playbookData,
    });
  }

  const actions = suggestionActions(message, lang);
  if (actions.length > 0) {
    blocks.push({
      id: `${message.id}-actions`,
      type: 'actions',
      title: t.actions,
      actions,
    });
  }

  if (message.tierHeroes && message.tierHeroes.length > 0) {
    blocks.push({
      id: `${message.id}-tier`,
      type: 'tier',
      title: t.tier,
      tierHeroes: message.tierHeroes,
    });
  }

  const sections = parseMarkdownSections(message.content);
  const hasTitled = sections.some((s) => Boolean(s.title));
  const hasStructured = blocks.length > 0;

  const reviewHowToWin = message.action === 'review';
  sections.forEach((section, index) => {
    if (hasStructured && !section.title && section.markdown.length < 48) {
      return;
    }
    const untitled = !section.title;
    let title = section.title
      || (hasTitled && untitled ? t.brief : (blocks.length === 0 && untitled ? t.analysis : undefined));

    if (reviewHowToWin && section.title) {
      const normalized = section.title.replace(/\s+/g, '').toLowerCase();
      if (normalized.includes('如何赢') || normalized.includes('howtowin') || normalized.includes('how to win')) {
        title = t.reviewHowToWin;
      }
    }

    if (reviewHowToWin && !section.title && index === sections.length - 1 && message.content.trim()) {
      title = t.reviewHowToWin;
    }

    blocks.push({
      id: `${message.id}-md-${index}`,
      type: title ? (reviewHowToWin ? 'review' : 'section') : 'markdown',
      title,
      markdown: section.markdown,
      reviewSection: reviewHowToWin && title === t.reviewHowToWin ? 'howToWin' : undefined,
      matchFact: reviewHowToWin ? message.matchFact : undefined,
    });
  });

  return blocks;
}

/** 用户问句 + 教练回复配成一次可检视的会话，供画布 / 历史轨使用 */
export function pairCoachSessions(messages: CoachMessage[], lang: Language = 'zh'): CoachSession[] {
  const sessions: CoachSession[] = [];
  let pendingUser: CoachMessage | null = null;

  for (const msg of messages) {
    if (msg.type === 'user') {
      pendingUser = msg;
      continue;
    }
    sessions.push({
      id: msg.id,
      query: pendingUser?.content,
      action: msg.action || pendingUser?.action,
      lesson: msg.lesson || pendingUser?.lesson,
      message: msg,
      blocks: messageToBlocks(msg, lang),
    });
    pendingUser = null;
  }

  return sessions;
}

export function sessionTitle(session: CoachSession, lang: Language): string {
  if (session.query) return session.query;
  const action = session.action;
  const map: Record<string, { zh: string; en: string }> = {
    analyze: { zh: '阵容分析', en: 'Draft analysis' },
    playbook: { zh: '本局打法', en: 'Playbook' },
    suggest: { zh: '推荐选人', en: 'Pick suggestion' },
    meta: { zh: '版本趋势', en: 'Patch trends' },
    review: { zh: '比赛复盘', en: 'Match review' },
  };
  if (action && map[action]) {
    return lang === 'zh' ? map[action].zh : map[action].en;
  }
  return lang === 'zh' ? '教练结果' : 'Coach result';
}

/** 过滤已收起的会话，供 A2UI 内联流使用 */
export function filterVisibleSessions(
  sessions: CoachSession[],
  dismissedIds: ReadonlySet<string>,
): CoachSession[] {
  return sessions.filter((s) => !dismissedIds.has(s.id));
}
