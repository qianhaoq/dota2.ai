import React from 'react';

export type StatusNoticeTone = 'error' | 'warning' | 'neutral';

interface StatusNoticeProps {
  tone?: StatusNoticeTone;
  title?: string;
  /** Optional leading icon (error alerts). */
  icon?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}

const TONE_STYLES: Record<StatusNoticeTone, { box: string; title: string; body: string }> = {
  error: {
    box: 'bg-red-500/10 border-red-500/20',
    title: 'text-red-400',
    body: 'text-red-400/90',
  },
  warning: {
    box: 'border-yellow-500/25 bg-yellow-500/5',
    title: 'text-yellow-400/90',
    body: 'text-k3-text-secondary',
  },
  neutral: {
    box: 'border-k3-border-subtle/80 bg-k3-elevated/20',
    title: 'text-k3-text-secondary',
    body: 'text-k3-text-secondary',
  },
};

/** Inline status banner for coach / review surfaces (cancel, fallback, failure). */
const StatusNotice: React.FC<StatusNoticeProps> = ({
  tone = 'neutral',
  title,
  icon,
  testId,
  children,
}) => {
  const styles = TONE_STYLES[tone];
  return (
    <div
      data-testid={testId}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 ${styles.box}`}
    >
      {icon && <span className="flex-shrink-0 mt-0.5">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && (
          <p className={icon
            ? `text-sm font-medium ${styles.title}`
            : `text-[11px] font-semibold mb-1 ${styles.title}`}
          >
            {title}
          </p>
        )}
        <div className={`text-xs sm:text-sm break-words ${styles.body} ${title && icon ? 'mt-1' : ''}`}>
          {children}
        </div>
      </div>
    </div>
  );
};

export default StatusNotice;
