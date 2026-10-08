// Renders the README pictures from the widget script's own draw calls (through
// the Scriptable mock), so they never drift from the code:
//
//   docs/lockscreen.svg  the widgets under the clock on a lock screen
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

// The top of a lock screen: date, clock and the widget row. No phone frame.
async function lockscreen() {
  const W = 390;
  const H = 290;
  const fiveHour = await render("accessoryCircular", { body: DEMO });
  const week = await render("accessoryCircular", { body: DEMO, parameter: "7d" });
  const rect = await render("accessoryRectangular", { body: usage(42, "2026-10-08T14:38:00Z", 18) });

  // Lock screen widget row: 72 pt columns with 12 pt gaps, centered under the clock.
  const rowWidth = CIRCLE * 2 + RECT_W + 12 * 2;
  const left = (W - rowWidth) / 2;
  const top = 186;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}">
  <clipPath id="card"><rect width="${W}" height="${H}" rx="28"/></clipPath>
  <g clip-path="url(#card)">${wallpaper("lock", W, H * 2.4)}
    <text x="${W / 2}" y="58" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="600" fill="#fff" fill-opacity="0.88">Thursday 8 October</text>
    <text x="${W / 2}" y="156" text-anchor="middle" font-family="${CLOCK_FONT}" font-size="100" font-weight="600" fill="#fff" fill-opacity="0.9" letter-spacing="-3">12:00</text>
    <g opacity="0.95">
      ${circularSvg(fiveHour, left, top)}
      ${circularSvg(week, left + CIRCLE + 12, top)}
      ${rectangularSvg(rect, left + (CIRCLE + 12) * 2, top)}
    </g>
  </g>
</svg>\n`;
}

async function states() {
  const cases = [
    ["5-hour limit", "42% used · resets in 1h 44m", { body: DEMO }],
    ["5-hour limit", "81% used · resets in 38 min", { body: usage(81, "2026-10-08T10:38:00Z", 63) }],
    ["Weekly limit (7d)", "18% used · resets in 4d 21h", { body: DEMO, parameter: "7d" }],
    ["No connection", "last known: 77% used", {
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
    ["Not set up yet", "tap it to add your key", { keychain: {} }]
  ];
  const cell = 150;
  const W = cases.length * cell + 20;
  const H = 150;
  let body = "";
  for (const [index, [title, detail, options]] of cases.entries()) {
    const widget = await render("accessoryCircular", options);
    const x = 10 + index * cell + (cell - CIRCLE) / 2;
    body += circularSvg(widget, x, 20);
    body += `<text x="${x + CIRCLE / 2}" y="118" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#fff">${esc(title)}</text>`;
    body += `<text x="${x + CIRCLE / 2}" y="134" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="500" fill="#fff" fill-opacity="0.75">${esc(detail)}</text>`;
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
