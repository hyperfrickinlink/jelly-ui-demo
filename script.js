import 'https://jelly-ui.com/package.js';

      const JellyIconButton = customElements.get('jelly-icon-button');

JellyIconButton.prototype.surfaceBorder = function () {
  const cs    = getComputedStyle(this);
  const width = parseFloat(cs.getPropertyValue('--jelly-stroke-width')) || 0;

  if (width <= 0) return null;   // opt-in, so untouched buttons stay as they are

  const color = cs.getPropertyValue('--jelly-stroke').trim()
    || cs.getPropertyValue('--jelly-color-border-default').trim()
    || 'transparent';

  return { width, color: this.resolveColor(color) };
};

const JellyCard = customElements.get('jelly-card');

// CSS border-radius overflow rule: if two radii on one edge exceed it, scale all four
const clampRadii = (w, h, [tl, tr, br, bl]) => {
  const f = Math.min(1, w / (tl + tr), w / (bl + br), h / (tl + bl), h / (tr + br));
  const k = Number.isFinite(f) ? f : 1;
  return [tl, tr, br, bl].map((r) => Math.max(0, r) * k);
};

const polygonArea = (pts) => {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
};

// Signed distance for a rect with four radii: pick the corner by quadrant
const sdf4 = (x, y, w, h, [tl, tr, br, bl]) => {
  const halfW = w / 2, halfH = h / 2;
  const r  = x >= 0 ? (y < 0 ? tr : br) : (y < 0 ? tl : bl);
  const rr = Math.min(r, halfW, halfH);
  const qx = Math.abs(x) - (halfW - rr);
  const qy = Math.abs(y) - (halfH - rr);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
};

function buildMembrane (width, height, [tl, tr, br, bl], samples, blendPasses) {
  const halfW = width / 2, halfH = height / 2;
  const dense = [], STEPS = 48;
  const push = (x, y) => dense.push({ x, y });

  const line = (ax, ay, bx, by, includeStart) => {
    for (let i = includeStart ? 0 : 1; i <= STEPS; i++) {
      const t = i / STEPS;
      push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  };
  const arc = (cx, cy, a0, a1, r) => {
    for (let i = 1; i <= STEPS; i++) {
      const a = a0 + (a1 - a0) * (i / STEPS);
      push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };

  // Clockwise from the top edge, matching the stock trace order and winding
  line(-halfW + tl, -halfH,      halfW - tr, -halfH,      true);
  arc (  halfW - tr, -halfH + tr, -Math.PI / 2, 0,          tr);
  line(  halfW,      -halfH + tr, halfW,       halfH - br, false);
  arc (  halfW - br,  halfH - br, 0, Math.PI / 2,           br);
  line(  halfW - br,  halfH,     -halfW + bl,  halfH,      false);
  arc ( -halfW + bl,  halfH - bl, Math.PI / 2, Math.PI,     bl);
  line( -halfW,       halfH - bl, -halfW,     -halfH + tl, false);
  arc ( -halfW + tl, -halfH + tl, Math.PI, Math.PI * 1.5,   tl);

  const cumulative = [0];
  let perimeter = 0;
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i], b = dense[(i + 1) % dense.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    cumulative.push(perimeter);
  }

  const points = [];
  for (let s = 0; s < samples; s++) {
    const target = (s / samples) * perimeter;
    let seg = 0;
    while (seg < dense.length - 1 && cumulative[seg + 1] < target) seg++;
    const a = dense[seg], b = dense[(seg + 1) % dense.length];
    const len = Math.max(cumulative[seg + 1] - cumulative[seg], 0.0001);
    const t = (target - cumulative[seg]) / len;
    points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: 0, ny: 0, d: 0, v: 0, z: 0, zv: 0 });
  }

  const at = (i) => points[(i + points.length) % points.length];
  let normals = points.map((_, i) => {
    const tx = at(i + 1).x - at(i - 1).x, ty = at(i + 1).y - at(i - 1).y;
    const L = Math.hypot(ty, -tx) || 1;
    return { nx: ty / L, ny: -tx / L };
  });
  for (let pass = 0; pass < blendPasses; pass++) {
    normals = normals.map((n, i) => {
      const p = normals[(i - 1 + normals.length) % normals.length];
      const q = normals[(i + 1) % normals.length];
      const nx = p.nx * 0.22 + n.nx * 0.56 + q.nx * 0.22;
      const ny = p.ny * 0.22 + n.ny * 0.56 + q.ny * 0.22;
      const L = Math.hypot(nx, ny) || 1;
      return { nx: nx / L, ny: ny / L };
    });
  }
  points.forEach((p, i) => { p.nx = normals[i].nx; p.ny = normals[i].ny; });

  return points;
}

class CornerCard extends JellyCard {
  // --jelly-corners: TL TR BR BL (px, same shorthand rules as border-radius)
  corners () {
    const raw = getComputedStyle(this).getPropertyValue('--jelly-corners').trim();
    const n = (raw.match(/-?[\d.]+/g) || []).map(Number).filter(Number.isFinite);
    if (n.length === 0) return [22, 22, 22, 22];
    if (n.length === 1) return [n[0], n[0], n[0], n[0]];
    if (n.length === 2) return [n[0], n[1], n[0], n[1]];
    if (n.length === 3) return [n[0], n[1], n[2], n[1]];
    return n.slice(0, 4);
  }

  shape (width, height) {
    const max = Math.max(...this.corners());
    return { width, height, radius: Math.min(max, Math.min(width, height) / 2) };
  }

  onShape () { super.onShape(); this.applyCorners(); }
  reshapeMembrane () { super.reshapeMembrane(); this.applyCorners(); }

  applyCorners () {
    const body = this.body;
    if (!body) return;
    const radii = clampRadii(body.width, body.height, this.corners());
    body.membrane = buildMembrane(body.width, body.height, radii, body.config.samples, body.config.normalBlendPasses);
    body.baseArea = polygonArea(body.getSurfacePoints());
    body.sdf = (x, y) => sdf4(x, y, body.width, body.height, radii);
    this.requestFrame();
  }
onBuilt () {
    super.onBuilt();
    this.wireHover();
  }

  wireHover () {
    const HOVER = 1;   // fraction of a full press the hover holds
    const TILT  = 1;   // parallax lean, clamped to 1 downstream
    const card  = this.card;
    let hovering = false;

    const track = (event) => {
      if (event.pointerType !== 'mouse' || this.reducedMotion || !this.body) return;
      if (this.pressing) return;               // a real press owns the body

      const p = this.toLocal(event.clientX, event.clientY);
      this.body.moveToLocal(p.x, p.y, HOVER);

      // fade the tilt out where the pointer is outside the jelly (cut corners)
      const inside = this.body.state.pointerInsideWeight / HOVER;
      const xn = Math.max(-1, Math.min(1, p.x / (this.body.width  / 2)));
      const yn = Math.max(-1, Math.min(1, p.y / (this.body.height / 2)));

      this.body.state.targetTiltY = -xn * TILT * inside;
      this.body.state.targetTiltX = -yn * TILT * inside;
      this.requestFrame();
    };

    card.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse' || this.reducedMotion || !this.body) return;
      hovering = true;
      const p = this.toLocal(event.clientX, event.clientY);
      this.body.pressAtLocal(p.x, p.y, 0.35, HOVER);   // small impulse on arrival
      this.requestFrame();
    });

    card.addEventListener('pointermove', track);
    card.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse') return;
      hovering = false;
      this.releaseBody();
    });

    // syncSquish's pointerup calls releaseBody(), which flattens the hover hold too
    card.addEventListener('pointerup', (event) => { if (hovering) track(event); });
  }
}

customElements.define('corner-card', CornerCard);
      document.querySelector('#scrollCue').addEventListener('click', () => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelector('#about')?.scrollIntoView({
    behavior: reduced ? 'auto' : 'smooth',
    block: 'start',
  });
        const scrollCue = document.querySelector('#scrollCue');
const sonar     = document.querySelector('.sonar');

scrollCue.addEventListener('click', () => {
  if (sonar && !sonar.classList.contains('is-done')) {
    sonar.classList.add('is-done');
    sonar.addEventListener('transitionend', () => sonar.remove(), { once: true });
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelector('#about')?.scrollIntoView({
    behavior: reduced ? 'auto' : 'smooth',
    block: 'start',
  });
});
});