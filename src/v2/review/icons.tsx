import React from 'react';

/**
 * Inline SVG icons for the v2 review conversation (mirrors the approved
 * prototype's ICON set). All are decorative — callers provide aria labels.
 */

const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconTurn: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />
  </svg>
);

export const IconFix: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M5 21V4m0 0h11l-2 4 2 4H5" />
  </svg>
);

export const IconNext: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M5 12h14m-5-5 5 5-5 5" />
  </svg>
);

export const IconChevron: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconCheck: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#15803D" />
    <path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconInfo: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" stroke="#64748B" strokeWidth="1.8" />
    <path d="M12 11v5.5" stroke="#64748B" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="7.8" r="1.2" fill="#64748B" />
  </svg>
);

export const IconMatch: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="4" stroke="#475569" strokeWidth="1.8" />
    <path d="M8 15l3-3 2 2 3-4" stroke="#475569" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconStop: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);

export const IconArrowDown: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);
