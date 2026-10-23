import React, { useState } from 'react';
import { Flag, MoveRight, RotateCcw } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { FactChip } from '../review/ConversationCards';
import { heroDisplayName } from '../review/heroDisplayName';
import type { Fact, Review } from '../review/types';
import GoldXpChart, { type SeriesMode } from './GoldXpChart';
import { DeathStrip, Feedback, GapBox, ItemsGrid, KV, KillerBars, MomentsList, Pager, Segmented, Sources, section, sectionH } from './bits';
import { buildMoments, fill, gapReason, gapRegistered, insightTimeChip, killerRows, sourcesFor } from './labels';

const insightIcon = (id: string) => {
    if (id === 'turning_point') return <RotateCcw size={14} aria-hidden="true"/>;
    if (id === 'fix_this') return <Flag size={14} aria-hidden="true"/>;
    return <MoveRight size={14} aria-hidden="true"/>;
};

/**
 * Shared evidence content for the mobile sheet and the desktop panel
 * (handoff §1 screen 5). Every visible metric string is an engine
 * `fact.display` — missing facts become GapBox entries, never invented numbers.
 */
export default function EvidenceBody({ review, claim, onPage, onClose }: {
    review: Review;
    /** 0-based claim index. */
    claim: number;
    onPage: (index: number) => void;
    /** Sheet-only ✕ button; the desktop panel passes undefined. */
    onClose?: () => void;
}) {
    const { t, lang } = useI18n();
    const [series, setSeries] = useState<SeriesMode>('both');
    const insight = review.insights[claim];
    if (!insight) return null;
    const facts = review.facts;
    const labelKey = insight.id === 'turning_point' ? 'cardTurning' : insight.id === 'fix_this' ? 'cardMistake' : 'cardNext';
    const time = insightTimeChip(review, insight);

    // The insight references the gold window delta; the xp window shares the
    // same window key (e.g. gold.window.40_45.delta → xp.window.40_45.delta).
    const windowKey = (() => {
        const id = insight.fact_ids.find(factId => /^gold\.window\..+\.delta$/.test(factId));
        return id ? id.slice('gold.window.'.length, -'.delta'.length) : null;
    })();
    const windowFact = (prefix: 'gold' | 'xp') => {
        if (!windowKey) return null;
        const base = `${prefix}.window.${windowKey}`;
        const delta = facts[`${base}.delta`];
        if (!delta) return null;
        return { delta, window: facts[base], start: facts[`${base}.start`], end: facts[`${base}.end`] };
    };
    const goldWindow = windowFact('gold'), xpWindow = windowFact('xp');
    const band: [number, number] | undefined = insight.time && insight.time.to > insight.time.from ? [insight.time.from, insight.time.to] : undefined;
    const bandLabel = goldWindow?.window?.display.t ?? xpWindow?.window?.display.t;

    const rows = killerRows(review, lang);
    const topKiller = rows[0]?.slug;
    const deathBandLabel = (() => {
        if (!band) return undefined;
        const anchor = (at: number) => Object.values(facts).find(f => f.t === at && f.display.t)?.display.t;
        const from = anchor(band[0]), to = anchor(band[1]);
        return from && to && from !== to ? `${from}–${to}` : from;
    })();

    const gapBoxFor = (topic: string) => {
        if (!gapRegistered(review, topic)) return null;
        const copy: Record<string, [string, string]> = {
            death_locations: [t('gapDeathT'), t('gapDeathP')],
            build_vs_lineup: [t('gapBuildT'), t('gapBuildP')],
            gold_fed: [t('gapGoldFedT'), t('gapGenericP')],
            time_dead: [t('gapTimeDeadT'), t('gapGenericP')],
        };
        const [title, body] = copy[topic] ?? [topic, t('gapGenericP')];
        return <GapBox title={title} body={body} reason={gapReason(review, topic)}/>;
    };

    const claimFacts = insight.fact_ids.map(id => facts[id]).filter((f): f is Fact => !!f);
    const enemies = review.roster.filter(h => h.team && h.team !== review.player?.team);

    return <div data-testid="evidence-body" data-claim={claim}>
      <div className="flex items-start justify-between gap-[8px] px-[16px] pt-[12px] pb-[10px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[6px] text-d2-12 font-semibold text-d2-ink-3">{insightIcon(insight.id)}<span>{t(labelKey)}{time ? <> · <span className="d2-tnum">{time}</span></> : null}</span></div>
          <div className="mt-[4px] text-d2-17 font-semibold">{insight.claim.text}</div>
        </div>
        <Pager claim={claim} total={review.insights.length} onPage={onPage} onClose={onClose}/>
      </div>

      {claim === 0 && <>
        <div className={section}>
          <Segmented value={series} onChange={setSeries}/>
          <GoldXpChart review={review} mode={series} band={band} bandLabel={bandLabel}/>
          <div className="flex gap-[14px] mt-[8px] text-d2-12 text-d2-ink-4">
            <span className="inline-flex items-center gap-[6px]"><svg width="16" height="6" aria-hidden="true"><line x1="0" y1="3" x2="16" y2="3" stroke="#B7791F" strokeWidth="2.2"/></svg>{t('legendGold')}</span>
            <span className="inline-flex items-center gap-[6px]"><svg width="16" height="6" aria-hidden="true"><line x1="0" y1="3" x2="16" y2="3" stroke="#94A3B8" strokeWidth="1.6" strokeDasharray="4 3"/></svg>{t('legendXP')}</span>
          </div>
        </div>
        {(goldWindow?.delta || xpWindow?.delta) && <div className={section}>
          <KV entries={[goldWindow, xpWindow]
              .filter((w): w is NonNullable<typeof w> => !!w?.delta)
              .map((w, i) => ({
                  value: w.delta!.display[lang],
                  label: `${i === 0 ? t('serGold') : t('serXP')}${w.window?.display.t ? ` · ${w.window.display.t}` : ''}`,
                  sub: w.start && w.end ? `${w.start.display[lang]} → ${w.end.display[lang]}` : undefined,
                  down: true,
              }))}/>
        </div>}
        <div className={section}>
          <h4 className={sectionH}>{t('keyMoments')}</h4>
          <MomentsList moments={buildMoments(review, insight, lang, t)}/>
        </div>
      </>}

      {claim === 1 && <>
        <div className={section}>
          <h4 className={sectionH}>{fill(t('evDeathsTitle'), { n: facts['deaths.total']?.display[lang] ?? '' }).replace(/\s+/g, ' ').trim()}</h4>
          <DeathStrip review={review} band={band} bandLabel={deathBandLabel} topKiller={topKiller}/>
          <div className="flex gap-[14px] mt-[6px] text-d2-12 text-d2-ink-4">
            {topKiller && <span className="inline-flex items-center gap-[6px]"><span className="inline-block w-[8px] h-[8px] rounded-full bg-d2-down"/>{heroDisplayName(topKiller, lang)}{facts[`killed_by.${topKiller}`] ? ` (${facts[`killed_by.${topKiller}`].display[lang]})` : ''}</span>}
            <span className="inline-flex items-center gap-[6px]"><span className="inline-block w-[8px] h-[8px] rounded-full bg-[#94A3B8]"/>{t('evOthers')}</span>
          </div>
        </div>
        <div className={section}>
          <h4 className={sectionH}>{t('whoKilled')}</h4>
          <KillerBars review={review}/>
        </div>
        {(facts['gold_fed'] || facts['time_dead']) && <div className={section}>
          <KV entries={[['gold_fed', t('goldFed')] as const, ['time_dead', t('timeDead')] as const]
              .filter(([id]) => facts[id])
              .map(([id, label]) => ({ value: facts[id].display[lang], label }))}/>
        </div>}
        {!facts['gold_fed'] && gapRegistered(review, 'gold_fed') && <div className={section}>{gapBoxFor('gold_fed')}</div>}
        {!facts['time_dead'] && gapRegistered(review, 'time_dead') && <div className={section}>{gapBoxFor('time_dead')}</div>}
        {gapRegistered(review, 'death_locations') && <div className={section}>{gapBoxFor('death_locations')}</div>}
      </>}

      {claim === 2 && <>
        <div className={section}>
          <h4 className={sectionH}>{t('whyAdvice')}</h4>
          <div className="flex flex-wrap gap-[8px]">{claimFacts.map(f => <FactChip key={f.id} fact={f}/>)}</div>
        </div>
        {enemies.length > 0 && <div className={section}>
          <h4 className={sectionH}>{t('enemyLineup')}</h4>
          <div className="flex flex-wrap gap-[8px]">{enemies.map(h => <span key={h.hero_id} className="inline-flex items-center gap-[6px] rounded-d2-chip bg-d2-surface-2 px-[10px] py-[4px] text-d2-13">
            <img className="w-[20px] h-[20px] rounded-[5px] object-cover" src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${h.hero}.png`} alt="" loading="lazy"/>
            {heroDisplayName(h.hero, lang)}
          </span>)}</div>
        </div>}
        <div className={section}>
          <h4 className={sectionH}>{t('itemTimings')}</h4>
          <ItemsGrid review={review}/>
        </div>
        {gapRegistered(review, 'build_vs_lineup') && <div className={section}>{gapBoxFor('build_vs_lineup')}</div>}
      </>}

      <div className={section}>
        <h4 className={sectionH}>{t('sources')}</h4>
        <Sources review={review} rows={sourcesFor(review, claim)}/>
      </div>
      <div className={`${section} pb-[24px]`}>
        <Feedback claim={claim}/>
      </div>
    </div>;
}
