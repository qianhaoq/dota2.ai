import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Language } from '../../../types';

interface SectionCardProps {
  title: React.ReactNode;
  /** Framed review-style card (border + tinted background). */
  framed?: boolean;
  /** Show an expand / collapse toggle. Defaults to true. */
  collapsible?: boolean;
  /** Controlled open state; leave undefined for uncontrolled. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (next: boolean) => void;
  /** One-line preview shown while collapsed. */
  preview?: string;
  /** UI language for default expand/collapse labels (中文 first). */
  lang?: Language;
  expandLabel?: string;
  collapseLabel?: string;
  children: React.ReactNode;
}

/** Titled, optionally collapsible card used for A2UI section blocks. */
const SectionCard: React.FC<SectionCardProps> = ({
  title,
  framed = false,
  collapsible = true,
  open,
  defaultOpen = true,
  onToggle,
  preview,
  lang = 'zh',
  expandLabel,
  collapseLabel,
  children,
}) => {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const toggle = () => {
    const next = !isOpen;
    setInnerOpen(next);
    onToggle?.(next);
  };
  const resolvedExpand = expandLabel ?? (lang === 'zh' ? '展开' : 'Expand');
  const resolvedCollapse = collapseLabel ?? (lang === 'zh' ? '收起' : 'Collapse');

  return (
    <section className={`min-w-0 ${framed ? 'rounded-lg border border-k3-border-subtle/80 bg-k3-elevated/20' : ''}`}>
      <div className={`flex items-center justify-between gap-2 mb-1.5 ${framed ? 'px-2.5 pt-2.5' : ''}`}>
        <h3 className="text-k3-text-primary font-semibold text-sm flex items-center gap-2 min-w-0">
          <span className="w-1 h-4 bg-k3-text-tertiary rounded-full flex-shrink-0" />
          <span className="truncate">{title}</span>
        </h3>
        {collapsible && (
          <button
            type="button"
            onClick={toggle}
            className="text-[11px] text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 min-h-[40px] flex-shrink-0 touch-manipulation"
          >
            {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {isOpen ? resolvedCollapse : resolvedExpand}
          </button>
        )}
      </div>
      {isOpen ? (
        <div className={framed ? 'px-2.5 pb-2.5' : undefined}>{children}</div>
      ) : (
        preview && (
          <p className={`text-xs text-k3-text-tertiary truncate ${framed ? 'px-2.5 pb-2.5' : ''}`}>
            {preview}
          </p>
        )
      )}
    </section>
  );
};

export default SectionCard;
