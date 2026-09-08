import React from 'react';

interface CardSkeletonProps {
  /** Caption shown under the skeleton (e.g. what is being loaded). */
  label?: string;
  /** lines: stacked text lines; grid: chip-like placeholder grid. */
  variant?: 'lines' | 'grid';
  /** Number of grid placeholder items (grid variant only). */
  gridItems?: number;
}

const CardSkeleton: React.FC<CardSkeletonProps> = ({ label, variant = 'lines', gridItems = 6 }) => {
  if (variant === 'grid') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" aria-hidden="true">
        {Array.from({ length: gridItems }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 p-2 rounded-sm border border-k3-border-subtle bg-k3-elevated/20 animate-pulse min-h-[44px]"
          >
            <span className="w-5 h-5 rounded-sm bg-k3-elevated flex-shrink-0" />
            <span className="flex-1 h-3 rounded bg-k3-elevated min-w-0" />
            <span className="w-10 h-3 rounded bg-k3-elevated flex-shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-k3-border-subtle/60 bg-k3-elevated/20 p-3 animate-pulse"
      aria-hidden="true"
    >
      <div className="h-3 w-24 rounded bg-k3-elevated mb-2" />
      <div className="h-4 w-3/4 max-w-xs rounded bg-k3-elevated mb-2" />
      <div className="h-3 w-full rounded bg-k3-elevated/70" />
      {label && <p className="text-[10px] text-k3-text-tertiary mt-2">{label}</p>}
    </div>
  );
};

export default CardSkeleton;
