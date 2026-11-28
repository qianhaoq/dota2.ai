import React from 'react';
import type { ChapterTopic } from './api';

/**
 * Crisp geometric Dota 2 tactical SVG iconography for the Ancient War-Room UI.
 * Pure inline vectors (zero external image dependencies, crisp at any DPI, decorative aria-hidden).
 */

interface IconProps {
  size?: number;
  className?: string;
}

/** Radiant / Dire Ancient faction crests. */
export const FactionCrest: React.FC<IconProps & { side: 'radiant' | 'dire' }> = ({ side, size = 15, className }) => (
  side === 'radiant' ? (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 2L17 7.5L14.5 17.5H5.5L3 7.5L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 5.5L13.5 9.5L10 14.5L6.5 9.5L10 5.5Z" fill="currentColor" fillOpacity="0.28" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M3 4.5L10 2L17 4.5L14.5 14L10 18L5.5 14L3 4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 7.5L10 12.5L13 7.5M10 5.5V12.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
);

/** Aegis diamond emblem for verdict / victory / header accents. */
export const AegisEmblem: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <path d="M10 1.8L17.2 5.4V10.6C17.2 14.5 14.1 17.3 10 18.6C5.9 17.3 2.8 14.5 2.8 10.6V5.4L10 1.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M10 5.2L13.4 9.8L10 14.4L6.6 9.8L10 5.2Z" fill="currentColor" fillOpacity="0.26" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

/** Crossed swords for match score & combat dividers. */
export const CrossedSwordsIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <path d="M4 16L15 5M12.5 4.5L15.5 4.5L15.5 7.5M3.5 13.5L6.5 16.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 16L5 5M7.5 4.5L4.5 4.5L4.5 7.5M16.5 13.5L13.5 16.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Replay verification shield checkmark. */
export const VerifiedShieldIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <path d="M10 2L16.5 4.8V9.8C16.5 13.9 13.7 16.9 10 18.2C6.3 16.9 3.5 13.9 3.5 9.8V4.8L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M7.1 10.1L9.1 12.1L13.2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Tactical map pin / route icon. */
export const MapRouteIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <rect x="2.5" y="2.5" width="15" height="15" rx="3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4.5 4.5L15.5 15.5" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.45" />
    <path d="M5.5 14.5C7.5 11.5 9.5 12 11 9.5C12 7.8 13 7 14.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="14.5" cy="5.5" r="1.6" fill="currentColor" />
  </svg>
);

/** Coach comms / ask bubble icon. */
export const CoachChatIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <path d="M3.5 5.5C3.5 4.4 4.4 3.5 5.5 3.5H14.5C15.6 3.5 16.5 4.4 16.5 5.5V12C16.5 13.1 15.6 14 14.5 14H8.5L4.8 16.8C4.3 17.2 3.5 16.8 3.5 16.1V5.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx="7.5" cy="8.8" r="1" fill="currentColor" />
    <circle cx="10.2" cy="8.8" r="1" fill="currentColor" />
    <circle cx="12.9" cy="8.8" r="1" fill="currentColor" />
  </svg>
);

/** Sidebar panel toggle icon. */
export const PanelToggleIcon: React.FC<IconProps & { open: boolean }> = ({ open, size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
    <line x1="12.5" y1="3.5" x2="12.5" y2="16.5" stroke="currentColor" strokeWidth="1.4" />
    {open ? (
      <path d="M7.5 8L9.8 10L7.5 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    ) : (
      <path d="M9.5 8L7.2 10L9.5 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    )}
  </svg>
);

/** Bespoke Dota 2 tactical icon for each chronological walkthrough chapter topic. */
export const ChapterTopicIcon: React.FC<IconProps & { topic: ChapterTopic }> = ({ topic, size = 16, className }) => {
  switch (topic) {
    case 'draft':
      return <CrossedSwordsIcon size={size} className={className} />;
    case 'game_plan':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M13.2 6.8L11.2 11.2L6.8 13.2L8.8 8.8L13.2 6.8Z" fill="currentColor" fillOpacity="0.24" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      );
    case 'laning':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M5 17H15M6.5 17V8.5L5.5 5H8V6.8H12V5H14.5L13.5 8.5V17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.8 17V12.5H11.2V17" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      );
    case 'midgame':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M10 2.5L12.1 7.6L17.5 8.2L13.4 11.8L14.6 17.2L10 14.3L5.4 17.2L6.6 11.8L2.5 8.2L7.9 7.6L10 2.5Z" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case 'vision_and_macro':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M2.5 10C4.3 6.6 6.9 5 10 5C13.1 5 15.7 6.6 17.5 10C15.7 13.4 13.1 15 10 15C6.9 15 4.3 13.4 2.5 10Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <circle cx="10" cy="10" r="2.4" fill="currentColor" fillOpacity="0.28" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case 'skills_and_items':
      return <AegisEmblem size={size} className={className} />;
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M10 3L16 10L10 17L4 10L10 3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <circle cx="10" cy="10" r="1.8" fill="currentColor" />
        </svg>
      );
  }
};
