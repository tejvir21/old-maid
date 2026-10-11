import { useEffect, useRef } from "react";

export function EventLog({ lines, className = "" }: { lines: { id: number; text: string; kind: "public" | "private" | "system" }[]; className?: string }) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [lines.length]);
  return (
    <section aria-label="Event log" className={`flex min-h-0 flex-col ${className}`}>
      <h2 className="mb-1 text-[10px] uppercase tracking-[0.35em] text-dim">Log</h2>
      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 text-xs leading-snug" aria-live="polite" aria-relevant="additions">
        {lines.slice(-30).map((l) => (
          <li key={`${l.kind}-${l.id}`} className={l.kind === "private" ? "text-bone" : l.kind === "system" ? "text-ember" : "text-dim"}>
            {l.kind === "private" && <span aria-hidden className="mr-1 text-ember">›</span>}
            {l.text}
          </li>
        ))}
        <li ref={end} aria-hidden />
      </ol>
    </section>
  );
}
