import type { ReactNode } from "react";
import { StatusBar } from "./StatusBar";

export function Page({ title, back = true, children, narrow = true }: { title?: string; back?: boolean; children: ReactNode; narrow?: boolean }) {
  return (
    <div className="room flex min-h-full flex-col">
      <StatusBar back={back} />
      <main className={`relative z-10 mx-auto w-full flex-1 px-4 pb-10 ${narrow ? "max-w-xl" : "max-w-3xl"}`}>
        {title && <h1 className="title-display mb-6 mt-2 text-3xl sm:text-4xl">{title}</h1>}
        {children}
      </main>
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <label className="flex min-h-[48px] cursor-pointer items-center justify-between gap-4 border-b border-bone/10 py-2">
      <span><span className="block text-sm uppercase tracking-[0.2em]">{label}</span>{hint && <span className="block text-xs text-dim">{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-10 cursor-pointer appearance-none rounded-full border border-bone/40 bg-ink transition checked:border-ember checked:bg-blood [&::before]:block [&::before]:h-4 [&::before]:w-4 [&::before]:translate-x-0.5 [&::before]:translate-y-px [&::before]:rounded-full [&::before]:bg-bone [&::before]:transition checked:[&::before]:translate-x-[1.35rem]" />
    </label>
  );
}

export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <fieldset className="border-b border-bone/10 py-3">
      <legend className="mb-2 text-sm uppercase tracking-[0.2em]">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}
            className={`min-h-[44px] min-w-[44px] border px-4 text-xs uppercase tracking-[0.2em] transition ${o.value === value ? "border-ember bg-blood/50 text-bone" : "border-bone/25 text-dim hover:border-bone/60"}`}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
