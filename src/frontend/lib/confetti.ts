/** Firecracker confetti engine — ported verbatim from the prototype fire(). */
const COLORS = ["#F59E2B", "#9FE6B8", "#2E8B4F", "#F3F1EA", "#6FE3A5", "#FF6B5C"];

type Part = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  age: number;
  c: string;
  w: number;
  h: number;
  rot: number;
  vr: number;
};

let raf = 0;

export function fireConfetti(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.parentElement) return;
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;

  const parts: Part[] = [];
  const bursts: [number, number][] = [
    [r.width * 0.2, r.height * 0.55],
    [r.width * 0.8, r.height * 0.55],
    [r.width * 0.5, r.height * 0.3],
  ];
  bursts.forEach(([bx, by], bi) => {
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 3 + Math.random() * 6;
      parts.push({
        x: bx,
        y: by,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 2,
        g: 0.16,
        life: 70 + Math.random() * 40,
        age: -bi * 12,
        c: COLORS[i % COLORS.length],
        w: 4 + Math.random() * 5,
        h: 2 + Math.random() * 4,
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 16,
      });
    }
  });

  cancelAnimationFrame(raf);
  const loop = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of parts) {
      p.age++;
      if (p.age < 0 || p.age > p.life) continue;
      alive = true;
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.vx *= 0.985;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive) raf = requestAnimationFrame(loop);
  };
  loop();
}

export function stopConfetti() {
  cancelAnimationFrame(raf);
}
