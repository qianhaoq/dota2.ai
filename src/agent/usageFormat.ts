import type { ReviewRunMeta, StageUsageBreakdown, TokenUsageBreakdown } from './api';

export type UsageLang = 'en' | 'zh' | 'ru';

const nonNegNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

const nonNegInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

/** Format a raw token count compactly (e.g. 850 -> "850", 12400 -> "12.4k", 10000 -> "10k", 1250000 -> "1.25M"). */
export function formatTokenCount(n: number): string {
  const safe = Math.max(0, Math.round(n));
  if (safe < 1000) return String(safe);
  if (safe < 999_950) {
    const k = Math.round(safe / 100) / 10;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  const m = Math.round(safe / 10_000) / 100;
  return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
}

function parseBreakdown(raw: unknown): TokenUsageBreakdown | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const input = nonNegNum(r.input);
  const output = nonNegNum(r.output);
  const inputUncached = nonNegNum(r.input_uncached);
  const cacheRead = nonNegNum(r.cache_read);
  const cacheWrite = nonNegNum(r.cache_write);
  const source = r.source === 'provider_usage' ? 'provider_usage' : r.source === null ? null : undefined;
  if (input == null && output == null && source === undefined) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    input_uncached: inputUncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    ...(source !== undefined ? { source } : {}),
  };
}

function parseStage(raw: unknown): StageUsageBreakdown | null {
  const base = parseBreakdown(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...base,
    steps: nonNegInt(r.steps) ?? 0,
    tool_calls: nonNegInt(r.tool_calls) ?? 0,
    ...(nonNegInt(r.truncation_retries) !== undefined ? { truncation_retries: nonNegInt(r.truncation_retries) } : {}),
  };
}

/** Defensively extract ReviewRunMeta from an untrusted JSON payload (e.g. a DSH ToolCard). */
export function parseReviewRunMeta(raw: unknown): ReviewRunMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const baseUsage = parseBreakdown(r.usage);
  const rawStages = r.usage && typeof r.usage === 'object' && !Array.isArray(r.usage)
    ? (r.usage as Record<string, unknown>).stages
    : null;
  let stages: NonNullable<ReviewRunMeta['usage']>['stages'];
  if (rawStages && typeof rawStages === 'object' && !Array.isArray(rawStages)) {
    const s = rawStages as Record<string, unknown>;
    const first = parseStage(s.first);
    const repair = parseStage(s.repair);
    const translate = parseStage(s.translate);
    if (first || repair || translate) {
      stages = {
        ...(first ? { first } : {}),
        ...(repair ? { repair } : {}),
        ...(translate ? { translate } : {}),
      };
    }
  }
  const usage = baseUsage ? { ...baseUsage, ...(stages ? { stages } : {}) } : null;
  const steps = nonNegInt(r.steps);
  const toolCalls = nonNegInt(r.tool_calls);
  const repairRounds = nonNegInt(r.repair_rounds);
  const truncationRetries = nonNegInt(r.truncation_retries);
  const model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null;
  const usageSource = r.usage_source === 'provider_usage'
    ? 'provider_usage'
    : r.usage_source === null
      ? null
      : usage?.source;
  if (!usage && steps === undefined) return null;
  return {
    ...(model ? { model } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
    ...(repairRounds !== undefined ? { repair_rounds: repairRounds } : {}),
    ...(truncationRetries !== undefined ? { truncation_retries: truncationRetries } : {}),
    ...(usage ? { usage } : {}),
    ...(usageSource !== undefined ? { usage_source: usageSource } : {}),
  };
}

function formatInputBreakdown(u: TokenUsageBreakdown, lang: UsageLang): string {
  const details: string[] = [];
  if (typeof u.cache_read === 'number') {
    const c = formatTokenCount(u.cache_read);
    details.push(lang === 'zh' ? `缓存命中 ${c}` : lang === 'ru' ? `${c} кэш` : `${c} cached`);
  }
  if (typeof u.cache_write === 'number' && (u.cache_write > 0 || u.cache_read == null)) {
    const w = formatTokenCount(u.cache_write);
    details.push(lang === 'zh' ? `缓存写入 ${w}` : lang === 'ru' ? `${w} запись кэша` : `${w} cache write`);
  }
  if (typeof u.input_uncached === 'number') {
    const uc = formatTokenCount(u.input_uncached);
    details.push(lang === 'zh' ? `未命中 ${uc}` : lang === 'ru' ? `${uc} без кэша` : `${uc} uncached`);
  }
  const totalIn = formatTokenCount(u.input);
  const totalOut = formatTokenCount(u.output);
  if (lang === 'zh') {
    return `输入 ${totalIn}${details.length ? `（${details.join('，')}）` : ''} · 输出 ${totalOut}`;
  }
  if (lang === 'ru') {
    return `${totalIn} вход${details.length ? ` (${details.join(', ')})` : ''} · ${totalOut} выход`;
  }
  return `${totalIn} in${details.length ? ` (${details.join(', ')})` : ''} · ${totalOut} out`;
}

function countParts(
  { steps, toolCalls, repairRounds, truncationRetries }: { steps?: number; toolCalls?: number; repairRounds?: number; truncationRetries?: number },
  lang: UsageLang,
): string[] {
  const out: string[] = [];
  if (typeof steps === 'number' && Number.isInteger(steps) && steps >= 0) {
    out.push(lang === 'zh' ? `${steps} 轮` : lang === 'ru' ? `${steps} шаг.` : `${steps} ${steps === 1 ? 'step' : 'steps'}`);
  }
  if (typeof toolCalls === 'number' && Number.isInteger(toolCalls) && toolCalls >= 0) {
    out.push(lang === 'zh' ? `${toolCalls} 次工具` : lang === 'ru' ? `${toolCalls} инстр.` : `${toolCalls} ${toolCalls === 1 ? 'tool' : 'tools'}`);
  }
  if (typeof repairRounds === 'number' && Number.isInteger(repairRounds) && repairRounds > 0) {
    out.push(lang === 'zh' ? `${repairRounds} 次修订` : lang === 'ru' ? `${repairRounds} правк.` : `${repairRounds} ${repairRounds === 1 ? 'repair' : 'repairs'}`);
  }
  if (typeof truncationRetries === 'number' && Number.isInteger(truncationRetries) && truncationRetries > 0) {
    out.push(lang === 'zh' ? `${truncationRetries} 次截断重试` : lang === 'ru' ? `${truncationRetries} повтор.` : `${truncationRetries} ${truncationRetries === 1 ? 'retry' : 'retries'}`);
  }
  return out;
}

const STAGE_LABELS: Record<'first' | 'repair' | 'translate', Record<UsageLang, string>> = {
  first: { en: 'First pass', zh: '首次生成', ru: 'Основной проход' },
  repair: { en: 'Fact repair', zh: '事实修订', ru: 'Проверка и правка' },
  translate: { en: 'Translation', zh: '多语翻译', ru: 'Перевод' },
};

export interface FormattedUsage {
  summary: string;
  sourceLabel: string;
  hasProviderUsage: boolean;
  stages: { key: 'first' | 'repair' | 'translate'; label: string; text: string }[];
}

/**
 * Build an honest, compact, bilingual summary of actual token usage and run counters.
 * Never fabricates currency prices or coerces unknown cache fields to 0.
 */
export function formatUsageSummary(meta: ReviewRunMeta | null | undefined, lang: UsageLang): FormattedUsage | null {
  if (!meta) return null;
  const usage = meta.usage ?? null;
  const hasSteps = typeof meta.steps === 'number' && Number.isInteger(meta.steps) && meta.steps >= 0;
  if (!usage && !hasSteps) return null;

  const explicitSource = meta.usage_source !== undefined ? meta.usage_source : usage?.source;
  const hasProviderUsage = Boolean(
    usage && (
      explicitSource === 'provider_usage'
      || (explicitSource === undefined && (usage.input > 0 || usage.output > 0))
    ),
  );

  const parts: string[] = [];
  if (hasProviderUsage && usage) {
    parts.push(formatInputBreakdown(usage, lang));
  } else {
    parts.push(
      lang === 'zh'
        ? '未返回 token 用量'
        : lang === 'ru'
          ? 'Токены не переданы провайдером'
          : 'Token usage unavailable',
    );
  }

  parts.push(...countParts({
    steps: meta.steps,
    toolCalls: meta.tool_calls,
    repairRounds: meta.repair_rounds,
    truncationRetries: meta.truncation_retries,
  }, lang));

  if (typeof meta.model === 'string' && meta.model.trim()) {
    parts.push(meta.model.trim());
  }

  const sourceLabel = hasProviderUsage
    ? (lang === 'zh'
      ? '来源：模型接口统计（仅展示真实 token，不估算费用）'
      : lang === 'ru'
        ? 'Источник: данные провайдера (только токены, без оценки цены)'
        : 'Source: provider usage (tokens only, no price estimate)')
    : (lang === 'zh'
      ? '来源：模型接口未返回用量'
      : lang === 'ru'
        ? 'Источник: провайдер не передал данные'
        : 'Source: not reported by provider');

  const stages: FormattedUsage['stages'] = [];
  if (usage?.stages) {
    for (const key of ['first', 'repair', 'translate'] as const) {
      const st = usage.stages[key];
      if (!st) continue;
      const stSource = st.source === 'provider_usage' || (st.source === undefined && (st.input > 0 || st.output > 0));
      const stParts = [
        stSource
          ? formatInputBreakdown(st, lang)
          : (lang === 'zh' ? '未返回 token 用量' : lang === 'ru' ? 'Нет данных о токенах' : 'Token usage unavailable'),
        ...countParts({
          steps: st.steps,
          toolCalls: key === 'translate' ? undefined : st.tool_calls,
          truncationRetries: st.truncation_retries,
        }, lang),
      ];
      stages.push({ key, label: STAGE_LABELS[key][lang], text: stParts.join(' · ') });
    }
  }

  return {
    summary: parts.join(' · '),
    sourceLabel,
    hasProviderUsage,
    stages,
  };
}
