import { A2UIAction, A2UIBlock, Language } from '../types';
import type { CoachMessage, CoachSession } from '../components/coach/coachMessage';

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

/**
 * 把一条教练消息映射成 A2UI 块。渲染层只吃 blocks，不解析聊天气泡。
 */
export function messageToBlocks(message: CoachMessage, lang: Language = 'zh'): A2UIBlock[] {
  const t = labels(lang);
  const blocks: A2UIBlock[] = [];

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
  sections.forEach((section, index) => {
    const untitled = !section.title;
    const title = section.title
      || (hasTitled && untitled ? t.brief : (blocks.length === 0 && untitled ? t.analysis : undefined));
    blocks.push({
      id: `${message.id}-md-${index}`,
      type: title ? 'section' : 'markdown',
      title,
      markdown: section.markdown,
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
  };
  if (action && map[action]) {
    return lang === 'zh' ? map[action].zh : map[action].en;
  }
  return lang === 'zh' ? '教练结果' : 'Coach result';
}
