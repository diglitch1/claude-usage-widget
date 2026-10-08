// Renders the README pictures from the widget script's own draw calls (through
// the Scriptable mock), so they never drift from the code:
//
//   docs/lockscreen.svg  the widgets placed on an iPhone lock screen
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
const FONT = "ui-rounded, 'SF Pro Rounded', 'SF Pro Display', system-ui, sans-serif";
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
    <linearGradient id="${id}-base" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#1d2b4f"/><stop offset="0.5" stop-color="#3b3f7a"/><stop offset="1" stop-color="#7a4a6e"/>
    </linearGradient>
    <filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${width / 9}"/></filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#${id}-base)"/>
  <g filter="url(#${id}-blur)" opacity="0.9">
    <circle cx="${width * 0.15}" cy="${height * 0.2}" r="${width * 0.38}" fill="#2f8f9d"/>
    <circle cx="${width * 0.9}" cy="${height * 0.35}" r="${width * 0.34}" fill="#d97757"/>
    <circle cx="${width * 0.45}" cy="${height * 0.95}" r="${width * 0.4}" fill="#c25b8a"/>
  </g>`;
}

async function lockscreen() {
  const W = 390;
  const H = 430;
  const fiveHour = await render("accessoryCircular", { body: DEMO });
  const week = await render("accessoryCircular", { body: DEMO, parameter: "7d" });
  const rect = await render("accessoryRectangular", { body: usage(42, "2026-10-08T14:38:00Z", 18) });

  // iOS lock screen widget row: 4 columns of 72 pt, 12 pt gaps, centered.
  const rowWidth = CIRCLE * 2 + RECT_W + 12 * 2;
  const left = (W - rowWidth) / 2;
  const top = 222;
  const phone = `
    <clipPath id="screen"><rect width="${W}" height="${H + 60}" rx="54"/></clipPath>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.72" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="fadeout"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>`;

  const screen = `${wallpaper("lock", W, H + 60)}
    <text x="${W / 2}" y="96" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="600" fill="#fff" fill-opacity="0.85">Thursday 8 October</text>
    <text x="${W / 2}" y="196" text-anchor="middle" font-family="${FONT}" font-size="104" font-weight="700" fill="#fff" fill-opacity="0.92" letter-spacing="-2">12:00</text>
    ${circularSvg(fiveHour, left, top)}
    ${circularSvg(week, left + CIRCLE + 12, top)}
    ${rectangularSvg(rect, left + (CIRCLE + 12) * 2, top)}
    <rect x="${W / 2 - 62}" y="18" width="124" height="34" rx="17" fill="#000"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${phone}</defs>
  <g mask="url(#fadeout)"><g clip-path="url(#screen)">${screen}</g>
  <rect x="1.5" y="1.5" width="${W - 3}" height="${H + 60}" rx="53" fill="none" stroke="#111" stroke-width="3"/></g>
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
