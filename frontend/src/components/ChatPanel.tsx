import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { EMOTES } from "@old-maid/shared";
import type { OnlineController } from "../store/onlineStore";

export function ChatPanel({ ctl, className = "" }: { ctl: OnlineController; className?: string }) {
  const chat = useStore(ctl.store, (s) => s.chat);
  const emotes = useStore(ctl.store, (s) => s.emotes);
  const you = useStore(ctl.store, (s) => s.view?.you);
  const [text, setText] = useState("");
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [chat.length]);
  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    void ctl.sendChat(t);
  };
  const names = useStore(ctl.store, (s) => s.view?.players ?? []);
  const lastEmote = emotes.at(-1);
  return (
    <section aria-label="Room chat" className={`flex min-h-0 flex-col border border-bone/10 bg-ink/70 p-2 ${className}`}>
      <h2 className="mb-1 text-[10px] uppercase tracking-[0.35em] text-dim">Chat</h2>
      {lastEmote && Date.now() - lastEmote.at < 6000 && (
        <p className="mb-1 text-xs text-dim" aria-live="polite">{names.find((p) => p.id === lastEmote.playerId)?.name ?? "Someone"}: <span className="text-lg">{lastEmote.emote}</span></p>
      )}
      <ul className="min-h-[3rem] flex-1 space-y-1 overflow-y-auto text-xs" aria-live="polite">
        {chat.map((m) => (
          // Rendered as plain text by React – never as HTML.
          <li key={m.id}><span className={m.playerId === you ? "text-ember" : "text-dim"}>{m.name}:</span> {m.text}</li>
        ))}
        <li ref={end} aria-hidden />
      </ul>
      <div className="my-1 flex gap-1" role="group" aria-label="Quick reactions">
        {EMOTES.map((e) => <button key={e} type="button" className="min-h-[36px] min-w-[36px] border border-bone/15 text-base hover:border-ember" aria-label={`React ${e}`} onClick={() => void ctl.emote(e)}>{e}</button>)}
      </div>
      <form onSubmit={send} className="flex gap-1">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} aria-label="Chat message" placeholder="Say something…" className="min-h-[40px] min-w-0 flex-1 border border-bone/25 bg-ink px-2 text-xs text-bone" />
        <button type="submit" className="btn !min-h-[40px] !px-3 !tracking-[0.1em]" disabled={!text.trim()}>Send</button>
      </form>
    </section>
  );
}
