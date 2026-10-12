import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServices } from "../app/context";
import { GameTable } from "../components/GameTable";
import { DrawReveal, FlyingCard, GameOverOverlay } from "../components/Overlays";
import { StartSequence } from "../components/StartSequence";
import { offlineVm } from "../game/tableVm";
import { useReducedMotion } from "../hooks/useMotion";
import { playSound } from "../sound/sound";
import { useOfflineUi, useSettingsStore } from "../store/ui";
import { NetBadge } from "../components/StatusBar";

export function OfflinePlay() {
  const svc = useServices();
  const nav = useNavigate();
  const loc = useLocation();
  const ui = useOfflineUi();
  const settings = useSettingsStore();
  const reduce = useReducedMotion();
  const [intro, setIntro] = useState(!!(loc.state as { intro?: boolean } | null)?.intro);
  const [missing, setMissing] = useState(false);

  // Page reload / reopened browser: restore the saved game from IndexedDB.
  useEffect(() => {
    if (ui.game) return;
    void svc.resumeOffline().then((ok) => { if (!ok) setMissing(true); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (missing) nav("/offline", { replace: true }); }, [missing, nav]);

  const game = ui.game;
  const base = useMemo(() => (game ? offlineVm(game, ui.reactionId, settings.values.debug) : null), [game, ui.version, ui.reactionId, settings.values.debug]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = intro || !!ui.reveal;
  const vm = base && { ...base, canAct: base.canAct && !blocked && !ui.finished };

  useEffect(() => { if (vm?.canAct) playSound("turn"); }, [vm?.canAct]);

  if (!game || !vm) return <div className="room flex min-h-full items-center justify-center text-dim">Loading game…</div>;

  const showOver = vm.finished && !ui.reveal && !intro;
  const again = async () => {
    useOfflineUi.getState().reset();
    await svc.startOffline({ ...game.config }, { hold: true });
    setIntro(true);
  };
  const leave = () => { svc.leaveOffline(); useOfflineUi.getState().reset(); nav("/"); };
  const names = vm.seats.map((s) => s.name);
  // seat order for the intro = table order (you first)
  const finalCounts = vm.seats.map((s) => s.cardCount);

  return (
    <>
      <GameTable
        vm={vm} reduce={reduce} busy={!!ui.reveal}
        onDraw={(id, choice) => void svc.offline.humanDraw(id, Number(choice))}
        header={
          <>
            <NetBadge />
            <div className="flex gap-2">
              <button type="button" className="btn !min-h-[40px] !px-3" aria-label={settings.values.sound ? "Mute sound" : "Unmute sound"} onClick={() => void settings.update(svc.repo, { sound: !settings.values.sound })}>
                {settings.values.sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              <button type="button" className="btn !min-h-[40px] !px-3 !tracking-[0.15em]" onClick={leave} disabled={vm.finished}>Save &amp; exit</button>
            </div>
            {settings.values.debug && <span className="text-[10px] uppercase tracking-[0.3em] text-ember">Debug</span>}
          </>
        }
        overlays={
          <>
            <FlyingCard fly={ui.fly} reduce={reduce} />
            <DrawReveal reveal={ui.reveal} reduce={reduce} onDone={() => useOfflineUi.getState().clearReveal()} />
            {intro && <StartSequence names={names} finalCounts={finalCounts} reduce={reduce} onDone={() => { setIntro(false); svc.offline.release(); }} />}
            {showOver && (
              <GameOverOverlay
                vm={vm} reduce={reduce}
                primary={{ label: "Play again", onClick: () => void again() }}
                secondary={{ label: "Main menu", onClick: leave }}
                note={[
                  ui.finished?.newAchievements.length ? `Achievement unlocked: ${ui.finished.newAchievements.map((a) => svc.repo.achievementTitle(a)).join(", ")}.` : "",
                  "Saved on this device. It will sync as an offline result when you're connected.",
                ].filter(Boolean).join(" ")}
              />
            )}
          </>
        }
      />
    </>
  );
}
