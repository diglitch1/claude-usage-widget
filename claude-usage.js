// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: tachometer-alt;

// Claude usage limits on the iOS lock screen (Scriptable).
//
// Run this script once inside the Scriptable app to paste your claude.ai session
// key. Then add a Scriptable lock screen widget and choose this script.
// Widget parameter "7d" makes the circular and inline widgets show the weekly
// window instead of the 5 hour one.

const BASE_URL = "https://claude.ai";
const USAGE_PAGE = "https://claude.ai/settings/usage";
const HELP_URL = "https://github.com/diglitch1/claude-usage-widget#2-get-your-session-key";
const KEYCHAIN_KEY = "claude-usage-widget.session-key";
const CACHE_FILE = "claude-usage-widget-cache.json";
const REFRESH_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_S = 15;
// iOS insets Scriptable's circular lock screen widget by a few points, which
// left the gauge floating small inside the circle. Negative padding pushes the
// image back out to the edge. Raise it if the ring still looks inset, lower it
// if the ring gets clipped.
const CIRCULAR_BLEED = 6;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Home screen colors. The lock screen ignores colors and renders everything as
// one tint, so there only brightness (alpha) matters.
const HOME_BACKGROUND = "#262624";
const HOME_ACCENT = "#D97757";

const ERRORS = {
  "no-key": { title: "Not set up", hint: "Tap to open the script", short: "setup" },
  auth: { title: "Session expired", hint: "Tap to paste a new key", short: "expired" },
  blocked: { title: "Blocked by Cloudflare", hint: "Retrying soon", short: "blocked" },
  network: { title: "Offline", hint: "Retrying soon", short: "offline" },
  "rate-limited": { title: "Rate limited", hint: "Retrying soon", short: "limited" },
  "no-org": { title: "No Claude org found", hint: "Check the account", short: "no org" },
  "not-found": { title: "Org not found", hint: "Retrying soon", short: "error" },
  http: { title: "Server error", hint: "Retrying soon", short: "error" },
  parse: { title: "Unexpected reply", hint: "The API may have changed", short: "error" }
};

class UsageError extends Error {
  constructor(kind, detail) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = ERRORS[kind] ? kind : "http";
    this.detail = detail || "";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers

function normalizeSessionKey(raw) {
  let key = String(raw || "").trim().replace(/^cookie:\s*/i, "");
  const fromCookie = key.match(/(?:^|;\s*)sessionKey=([^;\s]+)/);
  if (fromCookie) {
    key = fromCookie[1];
  }
  key = key.replace(/^["']+|["']+$/g, "");
  return /^[A-Za-z0-9_-]{20,}$/.test(key) ? key : null;
}

function looksLikeSessionKey(key) {
  return /^sk-ant-sid\d*-/.test(key || "");
}

function isCloudflarePage(body) {
  return /just a moment|cf-chl|challenge-platform|cf-ray|cloudflare/i.test(body || "");
}

function readWindow(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const raw = source.utilization;
  const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  const resetAt = typeof source.resets_at === "string" ? Date.parse(source.resets_at) : NaN;
  return {
    percent: Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null
  };
}

function normalizeUsage(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const fiveHour = readWindow(data.five_hour);
  const sevenDay = readWindow(data.seven_day);
  const hasData = [fiveHour, sevenDay].some((win) => win && win.percent !== null);
  return hasData ? { fiveHour, sevenDay } : null;
}

// Picks the claude.ai chat org. An account can also belong to API-only orgs,
// and a Max org lists both claude_pro and claude_max, so the strongest wins.
function pickOrganization(data) {
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.organizations) ? data.organizations : [];
  let best = null;
  let bestScore = -1;
  for (const org of list) {
    if (!org || typeof org !== "object") {
      continue;
    }
    const id = org.uuid || org.id;
    if (typeof id !== "string" || !id) {
      continue;
    }
    const caps = Array.isArray(org.capabilities) ? org.capabilities : [];
    const score = caps.includes("claude_max") ? 3
      : caps.includes("claude_pro") ? 2
      : caps.includes("chat") ? 1
      : 0;
    if (score > bestScore) {
      best = { id, name: typeof org.name === "string" ? org.name : "" };
      bestScore = score;
    }
  }
  return best;
}

// A window whose reset time has passed has started over, even if the cached
// numbers still say otherwise.
function currentWindow(win, now) {
  if (!win || win.percent === null) {
    return null;
  }
  if (win.resetAt !== null && win.resetAt <= now) {
    return { percent: 0, resetAt: null };
  }
  return win;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clockTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Time left until a reset, split for the circular widget: the big part on top,
// the smaller one under it. Rounds minutes up so it never shows "0m" early.
function countdownParts(resetAt, now) {
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) {
    return { big: `${days}d`, small: `${hours}h` };
  }
  if (hours > 0) {
    return { big: `${hours}h`, small: `${mins}m` };
  }
  return { big: `${mins}`, small: "min" };
}

function formatCountdown(resetAt, now) {
  const parts = countdownParts(resetAt, now);
  return parts.small === "min" ? `${parts.big}m` : `${parts.big} ${parts.small}`;
}

function formatResetLong(resetAt, now) {
  if (resetAt === null || resetAt === undefined) {
    return "no active window";
  }
  const sameDay = new Date(resetAt).toDateString() === new Date(now).toDateString();
  return `resets ${sameDay ? "today" : DAYS[new Date(resetAt).getDay()]} ${clockTime(resetAt)}`;
}

function percentText(win) {
  return win ? `${win.percent}%` : "--";
}

function nextRefresh(usage, now) {
  let next = now + REFRESH_MS;
  const fiveHour = usage && usage.fiveHour;
  // Redraw right after a reset so the widget does not show a full bar for
  // several minutes after the limit has already lifted.
  if (fiveHour && fiveHour.resetAt !== null && fiveHour.resetAt > now && fiveHour.resetAt < next) {
    next = fiveHour.resetAt + 15 * 1000;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Storage

function readSessionKey() {
  try {
    return Keychain.contains(KEYCHAIN_KEY) ? Keychain.get(KEYCHAIN_KEY) : null;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.documentsDirectory(), CACHE_FILE) };
}

function readCache() {
  try {
    const { fm, path } = cachePath();
    if (!fm.fileExists(path)) {
      return null;
    }
    const cache = JSON.parse(fm.readString(path));
    return cache && typeof cache === "object" ? cache : null;
  } catch (e) {
    return null;
  }
}

function writeCache(result) {
  try {
    const { fm, path } = cachePath();
    fm.writeString(path, JSON.stringify(result));
  } catch (e) {
    // A missing cache only costs the offline fallback.
  }
}

function clearCache() {
  try {
    const { fm, path } = cachePath();
    if (fm.fileExists(path)) {
      fm.remove(path);
    }
  } catch (e) {
    // Nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// claude.ai API (undocumented, the same endpoints the web app uses)

async function apiGet(path, sessionKey) {
  const req = new Request(BASE_URL + path);
  req.method = "GET";
  req.timeoutInterval = REQUEST_TIMEOUT_S;
  req.headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT
  };

  let body;
  try {
    body = await req.loadString();
  } catch (e) {
    throw new UsageError("network", e && e.message);
  }

  const status = req.response && req.response.statusCode ? req.response.statusCode : 0;
  if (status === 401) {
    throw new UsageError("auth", "HTTP 401");
  }
  if (status === 403) {
    throw new UsageError(isCloudflarePage(body) ? "blocked" : "auth", "HTTP 403");
  }
  if (status === 404) {
    throw new UsageError("not-found", "HTTP 404");
  }
  if (status === 429) {
    throw new UsageError("rate-limited", "HTTP 429");
  }
  if (status < 200 || status >= 300) {
    throw new UsageError(status === 0 ? "network" : "http", `HTTP ${status}`);
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new UsageError(isCloudflarePage(body) ? "blocked" : "parse", "body is not JSON");
  }
}

async function resolveOrganization(sessionKey) {
  const org = pickOrganization(await apiGet("/api/organizations", sessionKey));
  if (!org) {
    throw new UsageError("no-org");
  }
  return org;
}

async function fetchUsage(sessionKey, cached) {
  let org = cached && cached.orgId ? { id: cached.orgId, name: cached.orgName || "" } : null;
  const usageFor = async (id) => {
    const usage = normalizeUsage(
      await apiGet(`/api/organizations/${encodeURIComponent(id)}/usage`, sessionKey)
    );
    if (!usage) {
      throw new UsageError("parse", "no usage windows in reply");
    }
    return usage;
  };

  let usage;
  if (org) {
    try {
      usage = await usageFor(org.id);
    } catch (e) {
      // The cached org may be gone (left a team, switched accounts). Look it up
      // again once; a real auth problem shows up on the org listing too.
      if (e.kind !== "not-found" && e.kind !== "auth") {
        throw e;
      }
      org = null;
    }
  }
  if (!org) {
    org = await resolveOrganization(sessionKey);
    usage = await usageFor(org.id);
  }
  return { orgId: org.id, orgName: org.name, fetchedAt: Date.now(), usage };
}

// ---------------------------------------------------------------------------
// Drawing

function barImage(percent, width, height, fill, track) {
  const scale = 3;
  const ctx = new DrawContext();
  ctx.size = new Size(width * scale, height * scale);
  ctx.opaque = false;
  ctx.respectScreenScale = false;
  const radius = (height * scale) / 2;

  const trackPath = new Path();
  trackPath.addRoundedRect(new Rect(0, 0, width * scale, height * scale), radius, radius);
  ctx.addPath(trackPath);
  ctx.setFillColor(track);
  ctx.fillPath();

  if (percent > 0) {
    const filled = Math.max(height * scale, (width * scale * Math.min(percent, 100)) / 100);
    const fillPath = new Path();
    fillPath.addRoundedRect(new Rect(0, 0, filled, height * scale), radius, radius);
    ctx.addPath(fillPath);
    ctx.setFillColor(fill);
    ctx.fillPath();
  }
  return ctx.getImage();
}

// A thick arc with round ends, as one closed shape. Filling one shape (instead
// of stroking and adding cap dots) keeps semi-transparent tracks even.
function arcBand(center, radius, width, start, sweep) {
  const path = new Path();
  const half = width / 2;
  const at = (r, angle) => new Point(center + r * Math.cos(angle), center + r * Math.sin(angle));
  const steps = Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 120));
  const cap = (angle, from) => {
    const mid = at(radius, angle);
    for (let i = 1; i <= 12; i++) {
      const phi = from + Math.PI * (i / 12);
      path.addLine(new Point(mid.x + half * Math.cos(phi), mid.y + half * Math.sin(phi)));
    }
  };

  path.move(at(radius + half, start));
  for (let i = 1; i <= steps; i++) {
    path.addLine(at(radius + half, start + sweep * (i / steps)));
  }
  cap(start + sweep, start + sweep);
  for (let i = steps - 1; i >= 0; i--) {
    path.addLine(at(radius - half, start + sweep * (i / steps)));
  }
  cap(start, start + Math.PI);
  path.closeSubpath();
  return path;
}

function drawGauge(ctx, center, radius, width, percent, trackAlpha) {
  const start = 0.75 * Math.PI;
  const sweep = 1.5 * Math.PI;
  ctx.addPath(arcBand(center, radius, width, start, sweep));
  ctx.setFillColor(new Color("#FFFFFF", trackAlpha));
  ctx.fillPath();
  if (percent > 0) {
    ctx.addPath(arcBand(center, radius, width, start, (sweep * Math.min(percent, 100)) / 100));
    ctx.setFillColor(Color.white());
    ctx.fillPath();
  }
}

function drawCentered(ctx, text, font, alpha, top, height, size) {
  ctx.setFont(font);
  ctx.setTextColor(new Color("#FFFFFF", alpha));
  ctx.setTextAlignedCenter();
  ctx.drawTextInRect(text, new Rect(0, top, size, height));
}

// The whole circular widget as one image. iOS drops a widget's background image
// on the lock screen, so the arcs have to be real content, and the text goes in
// the same image to sit exactly inside them.
//   gauge: share of the window used   center: time until it resets
//   bottom gap: the exact percent
// One ring only: a second, inner ring left no room for readable text.
function circularImage(face) {
  const size = 180;
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = false;

  drawGauge(ctx, size / 2, 80, 17, face.percent, 0.3);
  drawCentered(ctx, face.big, Font.boldRoundedSystemFont(66), 1, 30, 76, size);
  drawCentered(ctx, face.small, Font.semiboldRoundedSystemFont(32), 0.85, 100, 38, size);
  drawCentered(ctx, face.bottom, Font.boldRoundedSystemFont(26), 1, 144, 32, size);
  return ctx.getImage();
}

// ---------------------------------------------------------------------------
// Widgets

function addLine(container, text, font, opacity, color) {
  const line = container.addText(text);
  line.font = font;
  if (color) {
    line.textColor = color;
  }
  line.lineLimit = 1;
  line.minimumScaleFactor = 0.6;
  if (opacity !== undefined) {
    line.textOpacity = opacity;
  }
  return line;
}

// What the countdown says when there is nothing to count down.
function idleText(win) {
  return win ? "unused" : "--";
}

function buildRectangular(widget, state, now, theme) {
  const size = theme.home ? 15 : 13;

  if (!state.result) {
    const error = ERRORS[state.error ? state.error.kind : "no-key"];
    addLine(widget, "Claude usage", Font.semiboldRoundedSystemFont(size - 1), 0.7, theme.text);
    addLine(widget, error.title, Font.boldRoundedSystemFont(size + 1), 1, theme.text);
    addLine(widget, error.hint, Font.mediumRoundedSystemFont(size - 2), 0.7, theme.text);
    return;
  }

  const usage = state.result.usage;
  const blocks = [["5h:", usage.fiveHour], ["Week:", usage.sevenDay]];
  blocks.forEach(([label, raw], index) => {
    const win = currentWindow(raw, now);
    if (index > 0) {
      widget.addSpacer(theme.home ? 10 : 4);
    }

    const head = widget.addStack();
    head.layoutHorizontally();
    head.centerAlignContent();
    head.spacing = 4;
    addLine(head, label, Font.boldRoundedSystemFont(size), 1, theme.text);
    const resetIn = win && win.resetAt !== null ? formatCountdown(win.resetAt, now) : idleText(win);
    addLine(head, resetIn, Font.mediumRoundedSystemFont(size), 1, theme.text);
    if (index === 0 && state.error) {
      // Cached numbers: say why they are not fresh.
      head.addSpacer();
      addLine(head, ERRORS[state.error.kind].short, Font.mediumRoundedSystemFont(size - 3), 0.6, theme.text);
    }

    widget.addSpacer(3);
    const bar = widget.addImage(
      barImage(win ? win.percent : 0, theme.barWidth, theme.barHeight, theme.fill, theme.track)
    );
    bar.imageSize = new Size(theme.barWidth, theme.barHeight);
  });
}

function circularFace(state, now, windowKey) {
  const usage = state.result && state.result.usage;
  if (!usage) {
    const short = ERRORS[state.error ? state.error.kind : "no-key"].short;
    return { percent: 0, big: "!", small: short, bottom: "" };
  }
  const main = currentWindow(usage[windowKey], now);
  const parts = main && main.resetAt !== null ? countdownParts(main.resetAt, now) : null;
  return {
    percent: main ? main.percent : 0,
    big: parts ? parts.big : windowKey === "sevenDay" ? "7d" : "5h",
    small: state.error ? ERRORS[state.error.kind].short : parts ? parts.small : idleText(main),
    bottom: percentText(main)
  };
}

function buildCircular(widget, state, now, windowKey) {
  widget.setPadding(-CIRCULAR_BLEED, -CIRCULAR_BLEED, -CIRCULAR_BLEED, -CIRCULAR_BLEED);
  const image = widget.addImage(circularImage(circularFace(state, now, windowKey)));
  image.centerAlignImage();
}

function buildInline(widget, state, now, windowKey) {
  const usage = state.result && state.result.usage;
  let text;
  if (!usage) {
    text = `Claude: ${ERRORS[state.error ? state.error.kind : "no-key"].short}`;
  } else {
    const win = currentWindow(usage[windowKey], now);
    const label = windowKey === "sevenDay" ? "Week" : "5h";
    text = `Claude ${label} ${percentText(win)}`;
    if (win && win.resetAt !== null) {
      text += ` · ${formatCountdown(win.resetAt, now)}`;
    }
    if (state.error) {
      text += " (old)";
    }
  }
  addLine(widget, text, Font.mediumRoundedSystemFont(12));
}

function buildWidget(family, state, now, parameter) {
  const widget = new ListWidget();
  const windowKey = String(parameter || "").trim().toLowerCase() === "7d" ? "sevenDay" : "fiveHour";
  const kind = state.error ? state.error.kind : "no-key";
  const needsScript = !state.result && (kind === "no-key" || kind === "auth");
  widget.url = needsScript ? `scriptable:///run/${encodeURIComponent(Script.name())}` : USAGE_PAGE;
  widget.refreshAfterDate = new Date(nextRefresh(state.result && state.result.usage, now));

  if (family === "accessoryInline") {
    buildInline(widget, state, now, windowKey);
  } else if (family === "accessoryCircular") {
    buildCircular(widget, state, now, windowKey);
  } else if (family === "accessoryRectangular") {
    buildRectangular(widget, state, now, {
      home: false,
      barWidth: 150,
      barHeight: 6,
      fill: Color.white(),
      track: new Color("#FFFFFF", 0.25)
    });
  } else {
    // Home screen sizes: same content, with real colors.
    widget.backgroundColor = new Color(HOME_BACKGROUND);
    buildRectangular(widget, state, now, {
      home: true,
      barWidth: family === "small" ? 123 : 290,
      barHeight: 8,
      fill: new Color(HOME_ACCENT),
      track: new Color("#FFFFFF", 0.15),
      text: Color.white()
    });
  }
  return widget;
}

async function loadState(sessionKey) {
  const cached = readCache();
  if (!sessionKey) {
    return { result: null, error: new UsageError("no-key") };
  }
  try {
    const result = await fetchUsage(sessionKey, cached);
    writeCache(result);
    return { result, error: null };
  } catch (e) {
    const error = e instanceof UsageError ? e : new UsageError("http", e && e.message);
    const usable = cached && cached.usage ? cached : null;
    return { result: usable, error };
  }
}

// ---------------------------------------------------------------------------
// In-app setup

async function showMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("OK");
  await alert.presentAlert();
}

function describe(state, now) {
  const lines = [];
  if (state.error) {
    const error = ERRORS[state.error.kind];
    lines.push(`${error.title}. ${error.hint}.`);
    if (state.error.detail) {
      lines.push(`(${state.error.detail})`);
    }
  }
  if (state.result) {
    const usage = state.result.usage;
    for (const [label, key] of [["5 hour", "fiveHour"], ["7 day", "sevenDay"]]) {
      const win = currentWindow(usage[key], now);
      lines.push(win
        ? `${label}: ${win.percent}% used, ${formatResetLong(win.resetAt, now)}`
        : `${label}: not reported`);
    }
    const age = state.error ? " (cached)" : "";
    lines.push(`Updated ${clockTime(state.result.fetchedAt)}${age}`);
    if (state.result.orgName) {
      lines.push(`Org: ${state.result.orgName}`);
    }
  }
  return lines.join("\n");
}

// Asks for a key and keeps asking until it is valid, verified or cancelled.
async function promptForKey(reason) {
  const alert = new Alert();
  alert.title = "Claude session key";
  alert.message = (reason ? reason + "\n\n" : "") +
    "Paste the value of the sessionKey cookie from claude.ai. It is stored in " +
    "Scriptable's keychain on this phone and only ever sent to claude.ai.";
  alert.addSecureTextField("sk-ant-sid01-...", "");
  alert.addAction("Save");
  alert.addAction("How do I get it?");
  alert.addCancelAction("Cancel");
  const choice = await alert.presentAlert();
  if (choice === -1) {
    return null;
  }
  if (choice === 1) {
    Safari.open(HELP_URL);
    return null;
  }

  const key = normalizeSessionKey(alert.textFieldValue(0));
  if (!key) {
    return promptForKey("That is not a session key. It is one long line starting with sk-ant-sid.");
  }

  const state = await loadState(key);
  if (state.error && state.error.kind === "auth") {
    return promptForKey("claude.ai rejected that key. Copy it again, it may have expired.");
  }
  if (state.error && !state.result) {
    const confirm = new Alert();
    confirm.title = "Could not check the key";
    confirm.message = `${ERRORS[state.error.kind].title}. Save it anyway?` +
      (looksLikeSessionKey(key) ? "" : "\n\nIt also does not start with sk-ant-sid.");
    confirm.addAction("Save anyway");
    confirm.addCancelAction("Cancel");
    if ((await confirm.presentAlert()) === -1) {
      return null;
    }
  }

  if (readSessionKey() !== key) {
    // Different key, maybe a different account: the cached org is not ours.
    clearCache();
    if (state.result) {
      writeCache(state.result);
    }
  }
  Keychain.set(KEYCHAIN_KEY, key);
  return key;
}

async function preview(family, state) {
  const widget = buildWidget(family, state, Date.now(), "");
  const present = {
    accessoryRectangular: "presentAccessoryRectangular",
    accessoryCircular: "presentAccessoryCircular",
    accessoryInline: "presentAccessoryInline"
  }[family];
  if (present && typeof widget[present] === "function") {
    await widget[present]();
  } else {
    await widget.presentSmall();
  }
}

async function runInApp() {
  let key = readSessionKey();
  if (!key) {
    key = await promptForKey("");
    if (!key) {
      return;
    }
  }

  let state = await loadState(key);
  while (true) {
    const menu = new Alert();
    menu.title = "Claude usage";
    menu.message = describe(state, Date.now());
    menu.addAction("Refresh");
    menu.addAction("Preview rectangular widget");
    menu.addAction("Preview circular widget");
    menu.addAction("Preview inline widget");
    menu.addAction("Replace session key");
    menu.addDestructiveAction("Remove session key");
    menu.addCancelAction("Done");
    const choice = await menu.presentSheet();

    if (choice === -1) {
      return;
    } else if (choice === 0) {
      state = await loadState(key);
    } else if (choice >= 1 && choice <= 3) {
      await preview(["accessoryRectangular", "accessoryCircular", "accessoryInline"][choice - 1], state);
    } else if (choice === 4) {
      const replaced = await promptForKey("");
      if (replaced) {
        key = replaced;
        state = await loadState(key);
      }
    } else if (choice === 5) {
      Keychain.remove(KEYCHAIN_KEY);
      clearCache();
      await showMessage("Removed", "The session key and cached usage are deleted from this phone.");
      return;
    }
  }
}

async function runWidget() {
  const now = Date.now();
  const state = await loadState(readSessionKey());
  const family = config.widgetFamily || "accessoryRectangular";
  Script.setWidget(buildWidget(family, state, now, args.widgetParameter));
}

async function main() {
  if (config.runsInWidget || config.runsInAccessoryWidget) {
    await runWidget();
  } else {
    await runInApp();
  }
  Script.complete();
}

if (typeof __CLAUDE_USAGE_TEST__ === "function") {
  __CLAUDE_USAGE_TEST__({
    normalizeSessionKey, looksLikeSessionKey, readWindow, normalizeUsage, pickOrganization,
    currentWindow, countdownParts, circularFace, formatCountdown, formatResetLong, nextRefresh, describe, buildWidget, main
  });
} else {
  await main();
}
