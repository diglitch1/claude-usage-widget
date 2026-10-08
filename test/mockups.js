// Renders the README pictures from the widget script's own draw calls (through
// the Scriptable mock), so they never drift from the code:
//
//   docs/lockscreen.svg  the widgets on a full iPhone 13 lock screen
//   docs/states.svg      what the circular widget shows in each situation
//
// The circular face is one drawn image, so it is exact apart from the font. The
// rectangular widget's stack layout is approximated.
//
//   npm run mockups

process.env.TZ = "Europe/Vienna";

const fs = require("node:fs");
const path = require("node:path");
const { runScript } = require("./scriptable-mock");

const NOW = Date.parse("2026-10-08T10:00:00Z");
const KEYCHAIN = { "claude-usage-widget.session-key": "sk-ant-sid01-mockupmockupmockupmockup" };
// System font stacks: Apple devices render these in SF Pro, the real iOS font.
const FONT = "ui-rounded, 'SF Pro Rounded', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const CLOCK_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif";
const CIRCLE = 72; // circular widget diameter in points (iPhone 13 class)
const RECT_W = 158;
const RECT_H = 72;

const usage = (p5, r5, p7) => ({
  five_hour: { utilization: p5, resets_at: r5 },
  seven_day: { utilization: p7, resets_at: "2026-10-13T07:00:00Z" }
});
const DEMO = usage(42, "2026-10-08T11:44:00Z", 18);

async function render(family, options) {
  const run = await runScript({
    now: NOW,
    family,
    keychain: KEYCHAIN,
    route: (url) => url.endsWith("/organizations")
      ? { body: [{ uuid: "org", capabilities: ["chat"] }] }
      : { body: options.body },
    ...options
  });
  return run.log.widgets[0];
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const n = (v) => Number(v.toFixed(2));

// DrawContext ops -> SVG, scaled by k.
function drawOps(ops, k) {
  let out = "";
  let fill;
  let shape;
  let font;
  let color;
  const d = (p) => p.map(([op, q]) =>
    op === "move" ? `M${n(q.x * k)} ${n(q.y * k)}`
      : op === "line" ? `L${n(q.x * k)} ${n(q.y * k)}`
        : op === "close" ? "Z" : "").join("");
  for (const op of ops) {
    if (op[0] === "fillColor") fill = op[1];
    if (op[0] === "path") shape = op[1];
    if (op[0] === "fill") {
      const rect = shape.find(([o]) => o === "rrect");
      out += rect
        ? `<rect x="${n(rect[1].x * k)}" y="${n(rect[1].y * k)}" width="${n(rect[1].width * k)}" height="${n(rect[1].height * k)}" rx="${n(rect[2] * k)}" fill="#fff" fill-opacity="${fill.alpha}"/>`
        : `<path d="${d(shape)}" fill="#fff" fill-opacity="${fill.alpha}"/>`;
    }
    if (op[0] === "font") font = op[1];
    if (op[0] === "textColor") color = op[1];
    if (op[0] === "text" && op[1]) {
      const r = op[2];
      const weight = font.weight.startsWith("bold") ? 700 : 600;
      out += `<text x="${n((r.x + r.width / 2) * k)}" y="${n((r.y + r.height / 2 + font.size * 0.36) * k)}" text-anchor="middle" font-family="${FONT}" font-weight="${weight}" font-size="${n(font.size * k)}" fill="#fff" fill-opacity="${color.alpha}">${esc(op[1])}</text>`;
    }
  }
  return out;
}

let clipId = 0;
function circularSvg(widget, x, y) {
  const id = `clip${clipId++}`;
  const image = widget.children[0].image;
  return `<g transform="translate(${x},${y})">
    <clipPath id="${id}"><circle cx="${CIRCLE / 2}" cy="${CIRCLE / 2}" r="${CIRCLE / 2}"/></clipPath>
    <g clip-path="url(#${id})">${drawOps(image.ops, CIRCLE / 180)}</g></g>`;
}

// Approximates the rectangular widget's vertical stack: text rows and bars.
function rectangularSvg(widget, x, y) {
  const rows = [];
  let height = 0;
  for (const child of widget.children) {
    if (child.kind === "spacer") {
      height += child.length || 0;
    } else if (child.kind === "stack") {
      const [label, value, status] = child.children.filter((c) => c.kind === "text");
      height += 14;
      rows.push(`<text x="0" y="${height}" font-family="${FONT}" font-size="13" fill="#fff"><tspan font-weight="700">${esc(label.text)}</tspan> <tspan font-weight="500">${esc(value.text)}</tspan></text>`);
      if (status) {
        rows.push(`<text x="${RECT_W}" y="${height}" text-anchor="end" font-family="${FONT}" font-size="10" fill="#fff" fill-opacity="0.6">${esc(status.text)}</text>`);
      }
      height += 3;
    } else if (child.kind === "image") {
      rows.push(`<g transform="translate(0,${height})">${drawOps(child.image.ops, 1 / 3)}</g>`);
      height += child.imageSize.height;
    }
  }
  // Widgets are vertically centered in their slot.
  return `<g transform="translate(${x},${y + (RECT_H - height) / 2})">${rows.join("")}</g>`;
}

// Soft iOS-style wallpaper: layered blurred color blobs.
function wallpaper(id, width, height) {
  return `<defs>
    <linearGradient id="${id}-base" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#0f1c3d"/><stop offset="0.45" stop-color="#2c3577"/><stop offset="1" stop-color="#5b2f63"/>
    </linearGradient>
    <filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.min(width, height) / 6}"/></filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#${id}-base)"/>
  <g filter="url(#${id}-blur)" opacity="0.85">
    <ellipse cx="${width * 0.1}" cy="${height * 0.18}" rx="${width * 0.45}" ry="${height * 0.2}" fill="#2a8fa3"/>
    <ellipse cx="${width * 0.95}" cy="${height * 0.45}" rx="${width * 0.4}" ry="${height * 0.22}" fill="#e07a4f"/>
    <ellipse cx="${width * 0.3}" cy="${height * 0.85}" rx="${width * 0.5}" ry="${height * 0.2}" fill="#b4477f"/>
  </g>`;
}

// Status bar icons of a notch iPhone: signal, Wi-Fi, battery.
function statusBar(W) {
  const x = W - 106;
  const bars = [4, 6.5, 9, 11.5].map((h, i) =>
    `<rect x="${x + i * 4.5}" y="${28 - h}" width="3" height="${h}" rx="1" fill="#fff"/>`).join("");
  const wifi = [10, 6.5, 3].map((r, i) =>
    `<path d="M${x + 33 - r} ${26 - r * 0.3} A${r} ${r} 0 0 1 ${x + 33 + r} ${26 - r * 0.3}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="${i === 2 ? 1 : 1}"/>`).join("") +
    `<circle cx="${x + 33}" cy="26.5" r="1.6" fill="#fff"/>`;
  const battery = `<rect x="${x + 50}" y="16.5" width="25" height="12" rx="3.6" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="1"/>
    <rect x="${x + 52}" y="18.5" width="17" height="8" rx="2" fill="#fff"/>
    <path d="M${x + 76.5} 20.5 a2 2 0 0 1 0 4" fill="#fff" fill-opacity="0.45"/>`;
  return bars + wifi + battery;
}

function padlock(cx, y) {
  return `<path d="M${cx - 4.5} ${y + 7} v-2.5 a4.5 4.5 0 0 1 9 0 v2.5" fill="none" stroke="#fff" stroke-width="2"/>
    <rect x="${cx - 7}" y="${y + 6.5}" width="14" height="11" rx="2.6" fill="#fff"/>`;
}

// Flashlight and camera buttons at the bottom of the lock screen.
function quickButton(cx, cy, glyph) {
  return `<circle cx="${cx}" cy="${cy}" r="25" fill="#000" fill-opacity="0.32"/>
    <circle cx="${cx}" cy="${cy}" r="25" fill="none" stroke="#fff" stroke-opacity="0.12"/>${glyph}`;
}

const FLASHLIGHT = (cx, cy) => `<path d="M${cx - 6} ${cy - 11} h12 v4 l-3 5 v13 a1.6 1.6 0 0 1 -1.6 1.6 h-2.8 a1.6 1.6 0 0 1 -1.6 -1.6 v-13 l-3 -5 z" fill="#fff"/>
  <circle cx="${cx}" cy="${cy + 1.5}" r="1.4" fill="#000" fill-opacity="0.5"/>`;
const CAMERA = (cx, cy) => `<path d="M${cx - 11} ${cy - 5} a2.5 2.5 0 0 1 2.5 -2.5 h3.5 l2 -3 h6 l2 3 h3.5 a2.5 2.5 0 0 1 2.5 2.5 v11 a2.5 2.5 0 0 1 -2.5 2.5 h-17 a2.5 2.5 0 0 1 -2.5 -2.5 z" fill="#fff"/>
  <circle cx="${cx}" cy="${cy + 1}" r="4.6" fill="#000" fill-opacity="0.55"/><circle cx="${cx}" cy="${cy + 1}" r="3" fill="#fff"/>`;

// A full iPhone 13 lock screen (390 x 844 pt) with the widgets under the clock.
async function lockscreen() {
  const W = 390;
  const H = 844;
  const B = 12; // bezel
  const fiveHour = await render("accessoryCircular", { body: DEMO });
  const week = await render("accessoryCircular", { body: DEMO, parameter: "7d" });
  const rect = await render("accessoryRectangular", { body: usage(42, "2026-10-08T14:38:00Z", 18) });

  // Lock screen widget row: 72 pt columns with 12 pt gaps, centered under the clock.
  const rowWidth = CIRCLE * 2 + RECT_W + 12 * 2;
  const left = (W - rowWidth) / 2;
  const top = 236;
  const notch = `<path d="M${W / 2 - 81} 0 h162 v4 a8 8 0 0 1 -0 0 c0 14 -6 26 -22 26 h-118 c-16 0 -22 -12 -22 -26 z" fill="#000"/>`;

  const screen = `${wallpaper("lock", W, H)}
    ${notch}
    ${statusBar(W)}
    ${padlock(W / 2, 50)}
    <text x="${W / 2}" y="108" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="600" fill="#fff" fill-opacity="0.88">Thursday 8 October</text>
    <text x="${W / 2}" y="206" text-anchor="middle" font-family="${CLOCK_FONT}" font-size="100" font-weight="600" fill="#fff" fill-opacity="0.9" letter-spacing="-3">12:00</text>
    <g opacity="0.95">
      ${circularSvg(fiveHour, left, top)}
      ${circularSvg(week, left + CIRCLE + 12, top)}
      ${rectangularSvg(rect, left + (CIRCLE + 12) * 2, top)}
    </g>
    ${quickButton(70, 772, FLASHLIGHT(70, 772))}
    ${quickButton(W - 70, 772, CAMERA(W - 70, 772))}
    <rect x="${W / 2 - 67}" y="${H - 13}" width="134" height="5" rx="2.5" fill="#fff"/>`;

  const OW = W + B * 2;
  const OH = H + B * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OW}" height="${OH}" viewBox="0 0 ${OW} ${OH}">
  <defs><clipPath id="screen"><rect width="${W}" height="${H}" rx="47"/></clipPath></defs>
  <rect x="-2" y="120" width="4" height="32" rx="1.5" fill="#2a2a2e"/>
  <rect x="-2" y="175" width="4" height="62" rx="1.5" fill="#2a2a2e"/>
  <rect x="-2" y="250" width="4" height="62" rx="1.5" fill="#2a2a2e"/>
  <rect x="${OW - 2}" y="200" width="4" height="96" rx="1.5" fill="#2a2a2e"/>
  <rect x="1" y="1" width="${OW - 2}" height="${OH - 2}" rx="58" fill="#0b0b0d" stroke="#3a3a3f" stroke-width="2"/>
  <g transform="translate(${B},${B})"><g clip-path="url(#screen)">${screen}</g></g>
</svg>\n`;
}

async function states() {
  const cases = [
    ["Plenty left", { body: DEMO }],
    ["Almost out", { body: usage(81, "2026-10-08T10:38:00Z", 63) }],
    ["Weekly (7d)", { body: DEMO, parameter: "7d" }],
    ["Offline", {
      files: {
        "/docs/claude-usage-widget-cache.json": JSON.stringify({
          orgId: "org",
          fetchedAt: NOW - 20 * 60 * 1000,
          usage: {
            fiveHour: { percent: 77, resetAt: NOW + 62 * 60 * 1000 },
            sevenDay: { percent: 30, resetAt: Date.parse("2026-10-13T07:00:00Z") }
          }
        })
      },
      route: () => ({ throws: "offline" })
    }],
    ["Not set up", { keychain: {} }]
  ];
  const cell = 100;
  const W = cases.length * cell + 20;
  const H = 136;
  let body = "";
  for (const [index, [caption, options]] of cases.entries()) {
    const widget = await render("accessoryCircular", options);
    const x = 10 + index * cell + (cell - CIRCLE) / 2;
    body += circularSvg(widget, x, 20);
    body += `<text x="${x + CIRCLE / 2}" y="118" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#fff" fill-opacity="0.9">${esc(caption)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}">
  <clipPath id="card"><rect width="${W}" height="${H}" rx="22"/></clipPath>
  <g clip-path="url(#card)">${wallpaper("states", W, H)}${body}</g>
</svg>\n`;
}

(async () => {
  const out = path.join(__dirname, "..", "docs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "lockscreen.svg"), await lockscreen());
  fs.writeFileSync(path.join(out, "states.svg"), await states());
  console.log("wrote docs/lockscreen.svg and docs/states.svg");
})();
