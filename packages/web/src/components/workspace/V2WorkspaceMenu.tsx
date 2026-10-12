'use client';

import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { workspaceMenuPosition } from './workspace-menu-position';

/** Native disclosure with one popup placement; content stays mounted when closed. */
export function V2WorkspaceMenu({
  trigger,
  triggerProps,
  width,
  panelClassName = '',
  children,
}: {
  trigger: ReactNode;
  triggerProps: ComponentPropsWithoutRef<'summary'> & { 'data-testid'?: string };
  width: number;
  panelClassName?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [contextWidth, setContextWidth] = useState(width);
  const [position, setPosition] = useState<ReturnType<typeof workspaceMenuPosition>>();
  const close = useCallback(() => {
    if (details.current) details.current.open = false;
    setOpen(false);
  }, []);
  useEffect(() => setPortal(document.body), []);
  useLayoutEffect(() => {
    const triggerNode = summary.current;
    const popup = panel.current;
    if (!portal || !open || !triggerNode || !popup) return;
    const boundary = triggerNode.closest<HTMLElement>('[data-v2-workspace-menu-boundary]') ?? details.current;
    if (!boundary) return;
    const measure = () => {
      if (!triggerNode.isConnected || triggerNode.getClientRects().length === 0) {
        close();
        return;
      }
      setContextWidth(boundary.clientWidth);
      const next = workspaceMenuPosition(
        triggerNode.getBoundingClientRect(),
        boundary.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        width,
        popup.scrollHeight + 2,
      );
      setPosition((previous) =>
        previous && Object.entries(next).every(([key, value]) => previous[key as keyof typeof previous] === value)
          ? previous
          : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(boundary);
    observer?.observe(popup);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, width, portal, close]);
  useEffect(() => {
    if (!open) return;
    const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]');
    Array.from(focusable ?? [])
      .find((node) => node.getClientRects().length > 0)
      ?.focus();
    const outside = (event: Event) => {
      if (!details.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      summary.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open, close]);
  return (
    <details ref={details} className="relative shrink-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary {...triggerProps} ref={summary} aria-controls={id}>
        {trigger}
      </summary>
      {portal &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              width: contextWidth,
              containerType: 'inline-size',
              pointerEvents: 'none',
              zIndex: 70,
            }}
          >
            <div
              id={id}
              ref={panel}
              hidden={!open}
              data-v2-workspace-menu=""
              style={{ ...position, pointerEvents: 'auto', display: open ? undefined : 'none' }}
              className={`fixed z-[70] overflow-auto overscroll-contain rounded-lg border border-cafe-subtle bg-cafe-surface p-1 text-cafe-black shadow-lg ${panelClassName}`}
            >
              {typeof children === 'function' ? children(close) : children}
            </div>
          </div>,
          portal,
        )}
    </details>
  );
}
