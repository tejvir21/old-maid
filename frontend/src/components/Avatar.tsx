/** Original, generated avatar: no external images, no likenesses. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, size = 44, dim = false }: { name: string; size?: number; dim?: boolean }) {
  const h = hue(name);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden
      className="relative shrink-0 overflow-hidden rounded-full ring-1 ring-bone/30"
      style={{
        width: size, height: size, opacity: dim ? 0.45 : 1,
        background: `radial-gradient(circle at 50% 30%, hsl(${h} 35% 34%), hsl(${(h + 40) % 360} 40% 12%) 80%)`,
      }}
    >
      {/* head + shoulders silhouette */}
      <div className="absolute left-1/2 top-[22%] -translate-x-1/2 rounded-full bg-black/55" style={{ width: size * 0.34, height: size * 0.34 }} />
      <div className="absolute left-1/2 top-[58%] -translate-x-1/2 rounded-t-full bg-black/55" style={{ width: size * 0.74, height: size * 0.5 }} />
      <span className="absolute inset-0 flex items-center justify-center font-display text-lg font-bold text-bone/90 mix-blend-overlay" style={{ fontSize: size * 0.42 }}>
        {initial}
      </span>
    </div>
  );
}
