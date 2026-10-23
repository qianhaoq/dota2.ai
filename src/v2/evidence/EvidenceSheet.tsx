import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';

const SNAP_LOW = 0.55, SNAP_HIGH = 0.92;
const CLOSED = 'translateY(100%)';
const snapTransform = (snap: number) => `translateY(${(1 - snap / SNAP_HIGH) * 100}%)`;

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Mobile (<1024px) evidence bottom sheet — 55%/92% snap heights, drag handle,
 * Esc/✕/scrim close, focus moves to the container on open (handoff §1 screen 5,
 * prototype openEvidence/snap/drag). Tab / Shift+Tab cycle inside the sheet
 * (focus trap) while aria-modal is advertised. Hidden on ≥1024 (the panel takes
 * over); MatchPage also only mounts it below lg. Reduced motion is handled
 * globally in tokens.css (all transitions off).
 */
export default function EvidenceSheet({ children, onClose }: {
    children: React.ReactNode;
    onClose: () => void;
}) {
    const { t } = useI18n();
    const sheet = useRef<HTMLDivElement>(null);
    const [entered, setEntered] = useState(false);
    const [closing, setClosing] = useState(false);
    const [snap, setSnap] = useState(SNAP_LOW);
    const snapRef = useRef(snap);
    snapRef.current = snap;
    const [dragY, setDragY] = useState<number | null>(null);
    const drag = useRef<{ y0: number; t0: number } | null>(null);

    const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // Request → animate out → unmount (instant under reduced motion).
    const requestClose = () => {
        if (closing) return;
        if (reduced()) {
            onClose();
            return;
        }
        setClosing(true);
        setTimeout(onClose, 320);
    };

    useEffect(() => {
        const frame = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    // Focus the sheet container (tabindex=-1) on open — not the close button.
    // MatchPage only mounts the sheet below lg, so it is always visible here.
    useEffect(() => {
        if (entered) sheet.current?.focus({ preventScroll: true });
    }, [entered]);

    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                requestClose();
                return;
            }
            if (event.key !== 'Tab' || !sheet.current) return;
            const nodes = focusables(sheet.current);
            // Container itself is focusable (tabIndex=-1) as the entry point.
            const cycle = nodes.length ? nodes : [sheet.current];
            const first = cycle[0];
            const last = cycle[cycle.length - 1];
            const active = document.activeElement as HTMLElement | null;
            const outside = !active || !sheet.current.contains(active);
            if (event.shiftKey) {
                if (outside || active === first || active === sheet.current) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (outside || active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', keydown, true);
        return () => document.removeEventListener('keydown', keydown, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closing]);

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        drag.current = { y0: event.clientY, t0: performance.now() };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current || !sheet.current) return;
        const top0 = (1 - snapRef.current / SNAP_HIGH) * sheet.current.offsetHeight;
        setDragY(Math.max(0, top0 + event.clientY - drag.current.y0));
    };
    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        const dy = event.clientY - drag.current.y0;
        const velocity = dy / (performance.now() - drag.current.t0);
        drag.current = null;
        setDragY(null);
        if (Math.abs(dy) < 4) return setSnap(snapRef.current > 0.7 ? SNAP_LOW : SNAP_HIGH);
        if (dy < -40) return setSnap(SNAP_HIGH);
        if (dy > window.innerHeight * 0.25 || velocity > 0.5) {
            return snapRef.current > 0.7 && dy < window.innerHeight * 0.4 ? setSnap(SNAP_LOW) : requestClose();
        }
    };

    const transform = closing ? CLOSED : dragY != null ? `translateY(${dragY}px)` : entered ? snapTransform(snap) : CLOSED;

    return <div className="fixed inset-0 z-40 lg:hidden" data-testid="evidence-sheet-layer">
      <div className="absolute inset-0 bg-d2-scrim transition-opacity duration-d2-sheet ease-d2-sheet" style={{ opacity: entered && !closing ? 1 : 0 }} onClick={requestClose}/>
      <div ref={sheet} role="dialog" aria-modal="true" aria-label={t('evidence')} tabIndex={-1}
        className="absolute left-0 right-0 bottom-0 h-[92%] max-w-[560px] mx-auto bg-d2-surface rounded-t-[24px] shadow-d2-sheet flex flex-col focus:outline-none transition-transform duration-d2-sheet ease-d2-sheet"
        style={{ transform, transition: dragY != null ? 'none' : undefined }}>
        <div className="flex-none h-[22px] grid place-items-center cursor-grab touch-none" data-testid="evidence-handle"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <i className="block w-[36px] h-[4px] rounded-[2px] bg-d2-disabled"/>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain pb-safe" data-testid="evidence-sheet-body">{children}</div>
      </div>
    </div>;
}
