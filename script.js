import 'https://jelly-ui.com/package.js';

      // opt-in hairline stroke via --jelly-stroke-width / --jelly-stroke, for
// jelly elements that don't paint a surfaceBorder of their own
function strokeFromVars () {
  const cs    = getComputedStyle(this);
  const width = parseFloat(cs.getPropertyValue('--jelly-stroke-width')) || 0;

  if (width <= 0) return null;   // untouched elements stay as they are

  const color = cs.getPropertyValue('--jelly-stroke').trim()
    || cs.getPropertyValue('--jelly-color-border-default').trim()
    || 'transparent';

  return { width, color: this.resolveColor(color) };
}

customElements.get('jelly-icon-button').prototype.surfaceBorder = strokeFromVars;
customElements.get('jelly-button').prototype.surfaceBorder = strokeFromVars;

/*
 * jelly-chip paints its own frame() (to ease the selected-state fill) and
 * never calls surfaceBorder(), so the stroke can't be opted in the same way.
 * A DOM-level CSS border doesn't work either: chip's shape() insets the
 * physics body 6px from the host box for the wobble, so a border drawn at
 * the host's full size sits outside the canvas pill with a visible gap of
 * background color between them. Painting the border in the same call as
 * the fill keeps both on the body's actual (inset) geometry.
 */
{
  const JellyChip = customElements.get('jelly-chip');
  JellyChip.prototype.frame = function (dt) {
    const body = this.body;
    if (!body) return false;

    const target = this.hasAttribute('selected') ? 1 : 0;
    if (this.selectTarget == null) this.selectTarget = target;
    this.selectTarget += (target - this.selectTarget) * Math.min(1, dt * 11);
    if (Math.abs(target - this.selectTarget) < 4e-3) this.selectTarget = target;

    body.update(dt);
    this.clearCanvas();
    this.paintBody(body, {
      fill: this.mixFill(this.selectTarget),
      ring: this.focusRing(),
      border: strokeFromVars.call(this),
    });

    return Math.abs(target - this.selectTarget) > 1e-3 || !body.isResting();
  };
}

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

/*
 * Before / after reveals.
 *
 * Each [data-reveal] card owns a jelly-segmented and a stack of screenshots.
 * The card shows BEFORE while it is low in the viewport and flips itself to
 * AFTER once its top edge climbs past REVEAL_POINT. Clicking the control by
 * hand hands the card over to the visitor and stops the scroll driving it.
 */
const REVEAL_POINT = 0.6;   // fraction of the viewport height, measured from the top

function wireReveals () {
  const checks = [...document.querySelectorAll('[data-reveal]')].map((card) => {
    const segmented = card.querySelector('jelly-segmented');
    const shots     = [...card.querySelectorAll('.shot')];
    if (!segmented || !shots.length) return null;

    let locked = false;

    const paint = (value) => {
      shots.forEach((shot) => shot.classList.toggle('is-active', shot.dataset.shot === value));
    };

    // The outer card is squishy: its pointerdown captures the pointer, which
    // retargets the compatibility click and swallows the segment press.
    segmented.addEventListener('pointerdown', (event) => event.stopPropagation());

    segmented.addEventListener('change', (event) => {
      locked = true;
      paint(event.detail.value);
    });

    paint(segmented.getAttribute('value') || 'before');

    return () => {
      if (locked) return;
      const above = card.getBoundingClientRect().top <= innerHeight * REVEAL_POINT;
      const want  = above ? 'after' : 'before';
      if (segmented.getAttribute('value') === want) return;
      segmented.setAttribute('value', want);   // moves the pill, emits no change
      paint(want);
    };
  }).filter(Boolean);

  if (!checks.length) return;

  let queued = false;
  const run = () => { queued = false; checks.forEach((check) => check()); };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };

  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  schedule();
}

// wait for the segmented to upgrade so its value attribute is actually honored
customElements.whenDefined('jelly-segmented').then(() => requestAnimationFrame(wireReveals));

/*
 * The selected segment's font-weight (750) is hardcoded on
 * .segment[aria-checked="true"] inside jelly-segmented's shadow root, and
 * the segment buttons expose no part to reach it from outside. Appending
 * an extra <style> after the shadow root's own wins the cascade tie by
 * source order, without touching the library or the unselected weight
 * (already 500 via .reveal-toggle's font-weight, inherited through
 * .segment's own font:inherit).
 */
document.querySelectorAll('jelly-segmented').forEach((segmented) => {
  const root = segmented.shadowRoot;
  if (!root) return;
  const style = document.createElement('style');
  style.textContent = '.segment[aria-checked="true"] { font-weight: 500; }';
  root.appendChild(style);
});

/*
 * Lightbox: click a reveal's screenshot to see it large in a jelly-dialog,
 * with a jelly-segmented inside to compare BEFORE/AFTER (arrow keys and
 * swipe drive the same segmented). The dialog owns its own backdrop-click,
 * Escape and focus handling, so this only wires the parts it doesn't: which
 * slide is showing, and keeping that in sync with the page's own toggle.
 */
function wireLightbox () {
  const dialog = document.querySelector('#lightbox');
  const toggle = dialog?.querySelector('#lightboxToggle');
  const img = dialog?.querySelector('.lightbox-img');
  const placeholder = dialog?.querySelector('.lightbox-placeholder');
  const counter = dialog?.querySelector('.lightbox-counter');
  if (!dialog || !toggle || !img || !placeholder || !counter) return;

  let card = null;      // the [data-reveal] card driving the on-page toggle, reveal mode only
  let slides = [];      // [{ value?, src?, alt }] - value only present in reveal mode
  let index = 0;

  const showIndex = (i) => {
    index = Math.max(0, Math.min(slides.length - 1, i));
    const slide = slides[index];
    if (!slide) return;

    if (slide.src) {
      img.src = slide.src;
      img.alt = slide.alt;
      img.hidden = false;
      placeholder.hidden = true;
    } else {
      img.hidden = true;
      placeholder.hidden = false;
      placeholder.textContent = slide.alt || 'Image placeholder';
    }

    if (slide.value) {
      if (toggle.getAttribute('value') !== slide.value) toggle.setAttribute('value', slide.value);
      card?.querySelectorAll('.shot').forEach((shot) => {
        shot.classList.toggle('is-active', shot.dataset.shot === slide.value);
      });
    } else {
      counter.textContent = `${index + 1} / ${slides.length}`;
    }
  };

  const step = (dir) => showIndex(index + dir);

  toggle.addEventListener('change', (event) => {
    const i = slides.findIndex((s) => s.value === event.detail.value);
    if (i >= 0) showIndex(i);
  });

  // reveal mode has a real BEFORE/AFTER toggle; gallery mode is plain
  // pagination through static images, so the toggle has nothing to show
  const openWith = (newSlides, startIndex, revealCard) => {
    card = revealCard;
    slides = newSlides;
    const isReveal = slides.every((s) => s.value);
    toggle.hidden = !isReveal;
    counter.hidden = isReveal;
    showIndex(startIndex);
    dialog.open = true;
  };

  document.querySelectorAll('[data-reveal] .reveal-media').forEach((trigger) => {
    // an ancestor squish card would otherwise capture this pointer and
    // swallow the click (same fix as the on-page jelly-segmented toggles)
    trigger.addEventListener('pointerdown', (event) => event.stopPropagation());
    trigger.addEventListener('click', () => {
      const revealCard = trigger.closest('[data-reveal]');
      const revealSlides = [...revealCard.querySelectorAll('.shot')].map((shot) => ({
        value: shot.dataset.shot,
        src: shot.currentSrc || shot.src,
        alt: shot.alt,
      }));
      const startValue = revealCard.querySelector('.shot.is-active')?.dataset.shot || 'before';
      openWith(revealSlides, Math.max(0, revealSlides.findIndex((s) => s.value === startValue)), revealCard);
    });
  });

  document.querySelectorAll('[data-gallery]').forEach((gallery) => {
    const triggers = [...gallery.querySelectorAll('.collage-card')];
    const gallerySlides = triggers.map((trigger) => {
      const image = trigger.querySelector('img');
      return {
        src: image?.currentSrc || image?.src || '',
        alt: image?.alt || trigger.textContent.trim(),
      };
    });
    triggers.forEach((trigger, i) => {
      trigger.addEventListener('pointerdown', (event) => event.stopPropagation());
      trigger.addEventListener('click', () => openWith(gallerySlides, i, null));
    });
  });

  // a lone reveal photo with no before/after and nothing to collage against -
  // opens straight to itself, no wrapper markup needed (the direct-child
  // selector is what excludes the images already handled above, which sit
  // nested inside a .reveal-collage/.collage-card instead)
  document.querySelectorAll('.reveal-card > img.reveal-photo').forEach((photo) => {
    photo.addEventListener('pointerdown', (event) => event.stopPropagation());
    photo.addEventListener('click', () => {
      openWith([{ src: photo.currentSrc || photo.src, alt: photo.alt }], 0, null);
    });
  });

  addEventListener('keydown', (event) => {
    if (!dialog.open) return;
    if (event.key === 'ArrowRight') step(1);
    if (event.key === 'ArrowLeft') step(-1);
  });

  let touchX = null;
  dialog.addEventListener('touchstart', (event) => { touchX = event.touches[0].clientX; }, { passive: true });
  dialog.addEventListener('touchend', (event) => {
    if (touchX === null) return;
    const dx = event.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) < 40) return;   // ignore taps / jitter
    step(dx < 0 ? 1 : -1);
  }, { passive: true });
}

wireLightbox();

/*
 * jelly-dialog ships its own native "close" button baked into its shadow
 * root. Swap it for a jelly-icon-button (same component the scroll cue
 * uses) so every clickable control on the page is a jelly-ui element.
 */
function jellyifyDialogClose (dialog) {
  const root = dialog.shadowRoot;
  const nativeClose = root?.querySelector('.close');
  if (!nativeClose) return;

  const button = document.createElement('jelly-icon-button');
  button.className = 'close';
  button.setAttribute('shape', 'circle');
  button.setAttribute('label', 'Close');
  button.style.setProperty('--jelly-fill', 'transparent');
  // the dialog's borrowed .close class fixes the host box at 30x30 for
  // positioning, but jelly-icon-button sizes its own internal button from
  // --jelly-icon-button-size independently (40px at size="small") - without
  // pinning it to match, the real button overflows the 30px host box
  button.style.setProperty('--jelly-icon-button-size', '30px');
  button.style.setProperty('--jelly-icon-button-radius', '15px');
  button.style.setProperty('--jelly-icon-button-icon-size', '13px');
  button.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 1L10 10M10 1L1 10" stroke="#180602" stroke-opacity="0.66" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
  button.addEventListener('click', () => { dialog.open = false; });

  nativeClose.replaceWith(button);
}

document.querySelectorAll('jelly-dialog').forEach(jellyifyDialogClose);

/*
 * jelly-button renders a native <button> in its shadow root, so wrapping it
 * in an <a> nests interactive content inside interactive content - invalid
 * HTML that Safari (unlike Chrome) refuses to activate on a left click.
 * Driving the navigation from a click listener avoids the nesting entirely.
 * Wired by class + data-href so every .project-bento's CTA picks this up.
 */
document.querySelectorAll('.project-cta[data-href]').forEach((cta) => {
  // kept for any squish ancestor: such a card's pointerdown
  // would otherwise capture the pointer and swallow/retarget this click -
  // same fix as the reveal-media triggers and the on-page toggles
  cta.addEventListener('pointerdown', (event) => event.stopPropagation());
  cta.addEventListener('click', () => {
    window.open(cta.dataset.href, '_blank', 'noopener');
  });
});

/*
 * Per-section color schemes.
 *
 * The dusty pink is the page default; a [data-theme] section takes the whole
 * palette over - background, card fills, strokes, buttons, type - while its
 * top edge sits above THEME_POINT, and hands it back on the way up.
 *
 * The fade is a JS lerp rather than a CSS transition because the jelly
 * components paint onto canvas. They re-resolve their colors from these
 * custom properties on every paint but sleep once their physics settle, so
 * the loop both rewrites the properties and nudges each component awake -
 * that is what carries the canvas surfaces along with the DOM ones. Their
 * own built-in fill crossfade then rides on top for free.
 */
const THEME_POINT = 0.55;   // fraction of the viewport height, from the top
const THEME_FADE_MS = 700;

const THEMES = {
  // keys must match across every palette - the lerp walks them positionally
  default: {
    '--medium-neutral': '#DFD3D0',
    '--light-neutral':  '#EAE2DC',
    '--dark-neutral':   '#D1B2AA',
    '--pale-neutral':   '#F7F0EC',
    '--type':           '#180602',
    '--subtitle-type':  '#18060285',
    '--accent':         '#D1B2AA',
    '--accent-label':   '#180602A8',
  },
  // Scripted brand: prescription yellow, not-quite-white, sorta black
  scripted: {
    '--medium-neutral': '#f5d9a4',
    '--light-neutral':  '#FEF9EF',
    '--dark-neutral':   '#CABBA5',
    '--pale-neutral':   '#FFFDF9',
    '--type':           '#0F0A0A',
    '--subtitle-type':  '#0F0A0A85',
    '--accent':         '#FFC559',
    '--accent-label':   '#0F0A0A',
  },
  /*
   * Delta: muted slate-navy ground (dark, but desaturated like the other two
   * palettes rather than a vivid brand navy), near-white panels layered
   * light-grey over white the way the Departures list stacks, a translucent
   * navy stroke, Delta red on the CTA. Safe to run this dark as a page
   * background because every --type / --subtitle-type consumer sits on a
   * light surface (bento, chip, placeholder box) - nothing paints body copy
   * straight onto the ground.
   */
  delta: {
    '--medium-neutral': '#273554',
    '--light-neutral':  '#F4F5F7',
    '--dark-neutral':   '#0F172E4D',
    '--pale-neutral':   '#FFFFFF',
    '--type':           '#101F3C',
    '--subtitle-type':  '#101F3C85',
    '--accent':         '#C8102E',
    '--accent-label':   '#FFFFFF',
  },
  /*
   * Showgirl: sage ground with a paler sage panel over it, cream prediction
   * cards, dark plum copy and the orange CTA. The stroke is that same plum
   * held translucent (like delta's) rather than the mockup's orange rings -
   * orange is doing accent duty here, and running it on every card border
   * and the toggle track as well would swamp the sage.
   */
  showgirl: {
    '--medium-neutral': '#8DBBA6',
    '--light-neutral':  '#C9DBD3',
    '--dark-neutral':   '#3E2C3440',
    '--pale-neutral':   '#FBEBDE',
    '--type':           '#593A4E',
    '--subtitle-type':  '#3E2C3485',
    '--accent':         '#E8722F',
    '--accent-label':   '#FFF4EA',
  },
};

// #RGB / #RRGGBB / #RRGGBBAA -> [r, g, b, a], alpha 0..1
function parseHex (hex) {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    parseInt(h.slice(6, 8), 16) / 255,
  ];
}

const toRgba = ([r, g, b, a]) =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

function wireSectionThemes () {
  const sections = [...document.querySelectorAll('[data-theme]')];
  if (!sections.length) return;

  const root = document.documentElement;
  const keys = Object.keys(THEMES.default);
  const palettes = Object.fromEntries(
    Object.entries(THEMES).map(([name, p]) => [name, keys.map((k) => parseHex(p[k]))]),
  );

  // canvas-painted components: they need waking, plain DOM repaints itself
  const jelly = [...document.querySelectorAll(
    'jelly-card, jelly-chip, jelly-button, jelly-icon-button, jelly-segmented, corner-card',
  )];

  let current = palettes.default.map((c) => [...c]);
  let from = null;
  let target = null;
  let startedAt = 0;
  let frame = 0;
  let active = null;

  const paint = () => {
    keys.forEach((key, i) => root.style.setProperty(key, toRgba(current[i])));
    for (const el of jelly) el.requestFrame?.();
  };

  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / THEME_FADE_MS);
    const eased = easeInOut(t);
    for (let i = 0; i < current.length; i++) {
      for (let c = 0; c < 4; c++) {
        current[i][c] = from[i][c] + (target[i][c] - from[i][c]) * eased;
      }
    }
    paint();
    frame = t < 1 ? requestAnimationFrame(step) : 0;
  };

  const goTo = (name, instant) => {
    if (name === active) return;
    active = name;
    target = palettes[name];

    if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      current = target.map((c) => [...c]);
      paint();
      return;
    }

    from = current.map((c) => [...c]);   // retarget mid-fade from where we are
    startedAt = performance.now();
    if (!frame) frame = requestAnimationFrame(step);
  };

  // the last themed section to have crossed the line wins; none -> default
  const wanted = () => {
    let name = 'default';
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= innerHeight * THEME_POINT) {
        name = section.dataset.theme;
      }
    }
    return name;
  };

  let queued = false;
  const check = () => { queued = false; goTo(wanted(), false); };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(check); } };

  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);

  goTo(wanted(), true);   // land on the right palette without fading in
}

wireSectionThemes();

      const scrollCue = document.querySelector('#scrollCue');
const sonar     = document.querySelector('.sonar');

// native scrollIntoView's "smooth" duration/easing varies enough across
// browsers to sometimes read as an instant jump - drive it ourselves so the
// scroll cue always animates, using the same easing as the theme fade
function smoothScrollTo (targetY, duration = 700) {
  const startY = scrollY;
  const delta = targetY - startY;
  if (Math.abs(delta) < 1) return;
  const startedAt = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / duration);
    scrollTo(0, startY + delta * easeInOut(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

scrollCue.addEventListener('click', () => {
  if (sonar && !sonar.classList.contains('is-done')) {
    sonar.classList.add('is-done');
    sonar.addEventListener('transitionend', () => sonar.remove(), { once: true });
  }

  const target = document.querySelector('#caseStudy');
  if (!target) return;

  const targetY = target.getBoundingClientRect().top + scrollY;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scrollTo(0, targetY);
    return;
  }
  smoothScrollTo(targetY);
});
