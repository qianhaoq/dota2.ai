import React from 'react';
import type { Authority } from '../types';
import type { Language } from '../../types';

export type EvidenceTone = Authority | 'gap';

export interface EvidenceBlock {
  /** How the statement is backed; drives the tag, not just a color. */
  authority: EvidenceTone;
  label: string;
  text: string;
}

export interface EvidenceLensProps {
  lang: Language;
  blocks: EvidenceBlock[];
  /** Optional closing rule, e.g. solid vs dashed line semantics. */
  note?: string;
}

const AUTHORITY_TAG: Record<EvidenceTone, string> = {
  fact: 'v3-tag v3-tag-fact',
  inference: 'v3-tag',
  user_report: 'v3-tag',
  hypothesis: 'v3-tag v3-tag-hypothesis',
  demo: 'v3-tag v3-tag-demo',
  gap: 'v3-tag v3-tag-gap',
};

const AUTHORITY_TEXT: Record<EvidenceTone, { zh: string; en: string }> = {
  fact: { zh: '事实', en: 'Fact' },
  inference: { zh: '推断', en: 'Inference' },
  user_report: { zh: '个人回忆', en: 'User report' },
  hypothesis: { zh: '假设', en: 'Hypothesis' },
  demo: { zh: '教学设定', en: 'Demo' },
  gap: { zh: '数据缺口', en: 'Gap' },
};

/**
 * EvidenceLens (catalog: dota-coach-ui/1) — 事实字段、时刻、缺口。
 * Facts carry a source; hypotheses are dashed; gaps are rust — never a fake
 * "verified" badge.
 */
const EvidenceLens: React.FC<EvidenceLensProps> = ({ lang, blocks, note }) => (
  <section className="v3-panel px-[16px] py-[14px]" aria-label={lang === 'zh' ? '依据' : 'Evidence'}>
    <div className="v3-eyebrow mb-[10px]">EVIDENCE LENS</div>
    <div className="space-y-[10px]">
      {blocks.map((block) => {
        const authorityText = block.label || AUTHORITY_TEXT[block.authority][lang === 'zh' ? 'zh' : 'en'];
        return (
          <div
            key={`${block.authority}-${block.text}`}
            className={`px-[12px] py-[10px] rounded-[4px] bg-v3-raised ${
              block.authority === 'hypothesis' ? 'v3-hypothesis-block' : ''
            }`}
          >
            <span className={AUTHORITY_TAG[block.authority]}>{authorityText}</span>
            <p className="mt-[6px] text-[12px] leading-[19px] text-v3-muted">{block.text}</p>
          </div>
        );
      })}
    </div>
    {note && <p className="mt-[10px] text-[11px] leading-[18px] text-v3-quiet">{note}</p>}
  </section>
);

export default EvidenceLens;
