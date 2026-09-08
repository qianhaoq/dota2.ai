import React from 'react';

interface InsightCardProps {
  /** Uppercase micro label above the insight body. */
  label?: string;
  /** Framed card (border + tinted background) vs bare labelled slot. */
  framed?: boolean;
  /** data-review-slot value for review surface slots. */
  slotKey?: string;
  testId?: string;
  children: React.ReactNode;
}

/** Labelled wrapper for a single review insight (summary, mistake, drill, …). */
const InsightCard: React.FC<InsightCardProps> = ({
  label,
  framed = false,
  slotKey,
  testId,
  children,
}) => (
  <div
    data-review-slot={slotKey}
    data-testid={testId}
    className={framed
      ? 'rounded-lg border border-k3-border-subtle/70 bg-k3-elevated/15 px-3 py-2.5'
      : undefined}
  >
    {label && (
      <p className="text-[11px] font-semibold text-k3-text-tertiary uppercase tracking-wide mb-1.5 px-0.5">
        {label}
      </p>
    )}
    {children}
  </div>
);

export default InsightCard;
