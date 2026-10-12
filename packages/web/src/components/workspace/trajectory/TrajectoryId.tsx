import { useEffect, useRef, useState } from 'react';

/** The displayed ID can shrink; the clipboard always receives the exact source value. */
export function TrajectoryId({ value, kind }: { value: string; kind: '调用' | '会话' }) {
  const [feedback, setFeedback] = useState('');
  const attempt = useRef(0);
  const currentValue = useRef(value);
  useEffect(() => {
    currentValue.current = value;
    attempt.current += 1;
    setFeedback('');
    return () => {
      attempt.current += 1;
    };
  }, [value]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 2000);
    return () => clearTimeout(timer);
  }, [feedback]);
  async function copy() {
    const request = ++attempt.current;
    try {
      await navigator.clipboard.writeText(value);
      if (request === attempt.current && currentValue.current === value) setFeedback('已复制');
    } catch {
      if (request === attempt.current && currentValue.current === value) setFeedback('复制失败');
    }
  }
  return (
    <span className="flex min-w-0 items-center gap-1 text-micro text-cafe-secondary">
      <button
        type="button"
        aria-label={`复制${kind} ID：${value}`}
        title={value}
        onClick={() => void copy()}
        className="min-w-0 truncate rounded px-1 py-1 text-left font-mono hover:bg-cafe-surface-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cafe-accent"
      >
        {kind} {value}
      </button>
      <output className="shrink-0">{feedback}</output>
    </span>
  );
}
