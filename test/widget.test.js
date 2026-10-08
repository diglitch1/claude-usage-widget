process.env.TZ = "Europe/Vienna";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runScript, loadHelpers, texts } = require("./scriptable-mock");

const NOW = Date.parse("2026-10-08T10:00:00Z"); // Thu 12:00 in Vienna
const KEY = "sk-ant-sid01-abcdefghijklmnopqrstuvwxyz0123456789_-AA";
const KEYCHAIN = { "claude-usage-widget.session-key": KEY };
const plain = (x) => JSON.parse(JSON.stringify(x)); // drop the vm realm's prototypes
const CACHE_PATH = "/docs/claude-usage-widget-cache.json";

const ORGS = [
  { uuid: "org-api", name: "API only", capabilities: ["api"] },
  { uuid: "org-max", name: "Personal", capabilities: ["chat", "claude_pro", "claude_max"] }
];
const USAGE = {
  five_hour: { utilization: 42, resets_at: "2026-10-08T12:30:00.000Z" }, // 14:30
  seven_day: { utilization: 18.4, resets_at: "2026-10-13T07:00:00.000Z" }, // Tue 09:00
  extra_usage: null
};

function api(overrides = {}) {
  return (url, headers) => {
    assert.equal(headers.Cookie, `sessionKey=${overrides.key || KEY}`);
    if (url === "https://claude.ai/api/organizations") {
      return overrides.orgs || { body: ORGS };
    }
    const m = url.match(/\/api\/organizations\/([^/]+)\/usage$/);
    if (m) {
      return overrides.usage ? overrides.usage(m[1]) : m[1] === "org-max"
        ? { body: USAGE }
        : { status: 404, body: { error: "not found" } };
    }
    throw new Error(`unexpected url ${url}`);
  };
}

function cache(overrides = {}) {
  return {
    [CACHE_PATH]: JSON.stringify({
      orgId: "org-max",
      orgName: "Personal",
      fetchedAt: NOW - 20 * 60 * 1000, // 11:40
      usage: {
        fiveHour: { percent: 77, resetAt: Date.parse("2026-10-08T11:00:00Z") },
        sevenDay: { percent: 30, resetAt: Date.parse("2026-10-13T07:00:00Z") }
      },
      ...overrides
    })
  };
}

async function widget(options) {
  const run = await runScript({ now: NOW, keychain: KEYCHAIN, route: api(), ...options });
  assert.equal(run.log.widgets.length, 1, "exactly one widget is set");
  assert.ok(run.log.completed, "Script.complete() is called");
  return { run, w: run.log.widgets[0], t: texts(run.log.widgets[0]) };
}

// --- pure helpers -----------------------------------------------------------

test("session key is accepted bare, quoted, or as a cookie line", async () => {
  const h = await loadHelpers({ now: NOW });
  assert.equal(h.normalizeSessionKey(`  ${KEY}\n`), KEY);
  assert.equal(h.normalizeSessionKey(`"${KEY}"`), KEY);
  assert.equal(h.normalizeSessionKey(`sessionKey=${KEY}`), KEY);
  assert.equal(h.normalizeSessionKey(`Cookie: a=1; sessionKey=${KEY}; b=2`), KEY);
  assert.equal(h.normalizeSessionKey(""), null);
  assert.equal(h.normalizeSessionKey("hello world"), null);
  assert.equal(h.normalizeSessionKey("short"), null);
  assert.ok(h.looksLikeSessionKey(KEY));
  assert.ok(!h.looksLikeSessionKey("abcdefghijklmnopqrstuvwxyz"));
});

test("usage windows tolerate missing, null and string values", async () => {
  const h = await loadHelpers({ now: NOW });
  assert.deepEqual(plain(h.readWindow({ utilization: 0, resets_at: null })), { percent: 0, resetAt: null });
  assert.deepEqual(plain(h.readWindow({ utilization: null, resets_at: null })), { percent: null, resetAt: null });
  assert.equal(h.readWindow({ utilization: "55.6" }).percent, 56);
  assert.equal(h.readWindow({ utilization: 140 }).percent, 100);
  assert.equal(h.readWindow({ utilization: -3 }).percent, 0);
  assert.equal(h.readWindow(null), null);
  assert.equal(h.readWindow({ utilization: 5, resets_at: "garbage" }).resetAt, null);
  assert.equal(h.normalizeUsage({}), null);
  assert.equal(h.normalizeUsage({ five_hour: null, seven_day: null }), null);
  assert.equal(h.normalizeUsage("nope"), null);
  assert.ok(h.normalizeUsage({ five_hour: null, seven_day: { utilization: 3 } }));
});

test("the strongest chat org wins over API-only orgs", async () => {
  const h = await loadHelpers({ now: NOW });
  assert.equal(h.pickOrganization(ORGS).id, "org-max");
  assert.equal(h.pickOrganization({ organizations: ORGS }).id, "org-max");
  assert.equal(h.pickOrganization([
    { uuid: "a", capabilities: ["chat"] },
    { uuid: "b", capabilities: ["chat", "claude_pro"] }
  ]).id, "b");
  assert.equal(h.pickOrganization([{ uuid: "solo" }]).id, "solo");
  assert.equal(h.pickOrganization([]), null);
  assert.equal(h.pickOrganization([null, { name: "no id" }]), null);
  assert.equal(h.pickOrganization({ error: "x" }), null);
});

test("reset times: clock under 12 hours, weekday beyond", async () => {
  const h = await loadHelpers({ now: NOW });
  assert.equal(h.formatReset(Date.parse("2026-10-08T12:30:00Z"), NOW), "14:30");
  const late = Date.parse("2026-10-08T20:00:00Z"); // 22:00
  assert.equal(h.formatReset(Date.parse("2026-10-08T23:05:00Z"), late), "01:05"); // past midnight
  assert.equal(h.formatReset(Date.parse("2026-10-13T07:00:00Z"), NOW), "Tue");
  assert.equal(h.formatReset(null, NOW), "--");
  assert.equal(h.formatResetLong(Date.parse("2026-10-08T12:30:00Z"), NOW), "resets today 14:30");
  assert.equal(h.formatResetLong(Date.parse("2026-10-13T07:00:00Z"), NOW), "resets Tue 09:00");
});

test("a window past its reset time counts as empty", async () => {
  const h = await loadHelpers({ now: NOW });
  assert.deepEqual(plain(h.currentWindow({ percent: 90, resetAt: NOW - 1 }, NOW)), { percent: 0, resetAt: null });
  assert.deepEqual(plain(h.currentWindow({ percent: 90, resetAt: NOW + 1 }, NOW)), { percent: 90, resetAt: NOW + 1 });
  assert.equal(h.currentWindow({ percent: null, resetAt: null }, NOW), null);
  assert.equal(h.currentWindow(null, NOW), null);
});

test("refresh comes right after a reset that is due soon", async () => {
  const h = await loadHelpers({ now: NOW });
  const soon = NOW + 60 * 1000;
  assert.equal(h.nextRefresh({ fiveHour: { percent: 99, resetAt: soon } }, NOW), soon + 15000);
  assert.equal(h.nextRefresh({ fiveHour: { percent: 9, resetAt: NOW + 3600000 } }, NOW), NOW + 300000);
  assert.equal(h.nextRefresh(null, NOW), NOW + 300000);
});

// --- widget runs ------------------------------------------------------------

test("rectangular lock screen widget shows both windows", async () => {
  const { run, w, t } = await widget({ family: "accessoryRectangular" });
  assert.deepEqual(t, ["5h", "42%", "14:30", "7d", "18%", "Tue", "Claude · 12:00"]);
  assert.equal(w.url, "https://claude.ai/settings/usage");
  assert.equal(w.refreshAfterDate.getTime(), NOW + 5 * 60 * 1000);
  assert.equal(w.backgroundColor, null, "lock screen widgets stay transparent");
  // First run has no cached org: list orgs, then fetch usage of the Max org.
  assert.deepEqual(run.requests.map((r) => r.url), [
    "https://claude.ai/api/organizations",
    "https://claude.ai/api/organizations/org-max/usage"
  ]);
  const saved = JSON.parse(run.files.get(CACHE_PATH));
  assert.equal(saved.orgId, "org-max");
  assert.equal(saved.usage.fiveHour.percent, 42);
});

test("a cached org skips the org lookup", async () => {
  const { run } = await widget({ family: "accessoryRectangular", files: cache() });
  assert.deepEqual(run.requests.map((r) => r.url), [
    "https://claude.ai/api/organizations/org-max/usage"
  ]);
});

test("a stale cached org is looked up again once", async () => {
  const { run, t } = await widget({ family: "accessoryRectangular", files: cache({ orgId: "org-gone" }) });
  assert.deepEqual(run.requests.map((r) => r.url), [
    "https://claude.ai/api/organizations/org-gone/usage",
    "https://claude.ai/api/organizations",
    "https://claude.ai/api/organizations/org-max/usage"
  ]);
  assert.ok(t.includes("42%"));
  assert.equal(JSON.parse(run.files.get(CACHE_PATH)).orgId, "org-max");
});

test("circular widget shows the 5h ring, or 7d with the parameter", async () => {
  const five = await widget({ family: "accessoryCircular" });
  assert.deepEqual(five.t, ["42%", "5h"]);
  assert.equal(five.w.addAccessoryWidgetBackground, true);
  assert.ok(five.w.backgroundImage, "ring is drawn");

  const seven = await widget({ family: "accessoryCircular", parameter: " 7D " });
  assert.deepEqual(seven.t, ["18%", "7d"]);
});

test("inline widget is one short line", async () => {
  assert.deepEqual((await widget({ family: "accessoryInline" })).t, ["Claude 5h 42% · 14:30"]);
  assert.deepEqual((await widget({ family: "accessoryInline", parameter: "7d" })).t, ["Claude 7d 18% · Tue"]);
});

test("home screen sizes get a background and white text", async () => {
  for (const family of ["small", "medium", "large"]) {
    const { w, t } = await widget({ family });
    assert.ok(w.backgroundColor, `${family} has a background`);
    assert.deepEqual(t.slice(0, 3), ["5h", "42%", "14:30"]);
    const walk = (n) => {
      if (n.kind === "text") assert.equal(n.textColor && n.textColor.hex, "FFFFFF", n.text);
      ("children" in n ? n.children : []).forEach(walk);
    };
    walk(w);
  }
});

test("no session key: setup prompt that opens the script", async () => {
  const { run, t, w } = await widget({ family: "accessoryRectangular", keychain: {} });
  assert.deepEqual(t, ["Claude usage", "Not set up", "Tap to open the script"]);
  assert.equal(w.url, "scriptable:///run/Claude%20Usage");
  assert.equal(run.requests.length, 0, "never calls the API without a key");
  assert.deepEqual((await widget({ family: "accessoryInline", keychain: {} })).t, ["Claude: setup"]);
  assert.deepEqual((await widget({ family: "accessoryCircular", keychain: {} })).t, ["!", "setup"]);
});

test("expired session without cache asks for a new key", async () => {
  const route = api({ orgs: { status: 403, body: { type: "error", error: { type: "permission_error" } } } });
  const { t, w } = await widget({ family: "accessoryRectangular", route });
  assert.deepEqual(t, ["Claude usage", "Session expired", "Tap to paste a new key"]);
  assert.equal(w.url, "scriptable:///run/Claude%20Usage");
});

test("Cloudflare challenge is not mistaken for an expired session", async () => {
  const page = "<!DOCTYPE html><title>Just a moment...</title><script src=/cdn-cgi/challenge-platform/x>";
  for (const status of [403, 200, 503]) {
    const route = api({ orgs: { status, body: page } });
    const { t } = await widget({ family: "accessoryRectangular", route });
    assert.equal(t[1], status === 503 ? "Server error" : "Blocked by Cloudflare", `status ${status}`);
  }
});

test("offline with cache shows the cached numbers and marks them", async () => {
  const route = () => ({ throws: "The Internet connection appears to be offline." });
  const { t, w } = await widget({ family: "accessoryRectangular", files: cache(), route });
  assert.deepEqual(t, ["5h", "77%", "13:00", "7d", "30%", "Tue", "offline · 11:40"]);
  assert.equal(w.url, "https://claude.ai/settings/usage");
  assert.deepEqual(
    (await widget({ family: "accessoryInline", files: cache(), route })).t,
    ["Claude 5h 77% · 13:00 (old)"]
  );
  assert.deepEqual((await widget({ family: "accessoryCircular", files: cache(), route })).t, ["77%", "offline"]);
});

test("cached window whose reset has passed shows 0%", async () => {
  const route = () => ({ throws: "offline" });
  const files = cache({
    usage: {
      fiveHour: { percent: 100, resetAt: NOW - 60 * 1000 },
      sevenDay: { percent: 64, resetAt: Date.parse("2026-10-13T07:00:00Z") }
    }
  });
  const { t } = await widget({ family: "accessoryRectangular", files, route });
  assert.deepEqual(t.slice(0, 6), ["5h", "0%", "--", "7d", "64%", "Tue"]);
});

test("rate limit, server error and garbage replies all keep the cache", async () => {
  const cases = [
    [{ status: 429, body: "" }, "limited"],
    [{ status: 500, body: "oops" }, "error"],
    [{ status: 200, body: "not json" }, "error"],
    [{ status: 200, body: { unrelated: true } }, "error"]
  ];
  for (const [reply, short] of cases) {
    const route = api({ usage: () => reply });
    const { t } = await widget({ family: "accessoryRectangular", files: cache(), route });
    assert.equal(t[1], "77%");
    assert.equal(t.at(-1), `${short} · 11:40`);
  }
});

test("a full limit and an unused window render cleanly", async () => {
  const route = api({
    usage: () => ({
      body: {
        five_hour: { utilization: 100, resets_at: "2026-10-08T10:02:00Z" },
        seven_day: { utilization: 0, resets_at: null }
      }
    })
  });
  const { t, w } = await widget({ family: "accessoryRectangular", route });
  assert.deepEqual(t.slice(0, 6), ["5h", "100%", "12:02", "7d", "0%", "--"]);
  assert.equal(w.refreshAfterDate.getTime(), Date.parse("2026-10-08T10:02:15Z"));
});

test("a reply with only one window still renders", async () => {
  const route = api({ usage: () => ({ body: { five_hour: { utilization: 12, resets_at: "2026-10-08T13:00:00Z" } } }) });
  const { t } = await widget({ family: "accessoryRectangular", route });
  assert.deepEqual(t.slice(0, 6), ["5h", "12%", "15:00", "7d", "--", "--"]);
});

// --- in-app setup -----------------------------------------------------------

test("first run: paste key, verify it, then show the menu", async () => {
  const run = await runScript({
    now: NOW,
    route: api(),
    alerts: [
      { title: "Claude session key", action: "Save", fields: [`sessionKey=${KEY}`] },
      { title: "Claude usage", action: "cancel" }
    ]
  });
  assert.equal(run.keychain.get("claude-usage-widget.session-key"), KEY);
  const menu = run.log.alerts[1];
  assert.match(menu.message, /5 hour: 42% used, resets today 14:30/);
  assert.match(menu.message, /7 day: 18% used, resets Tue 09:00/);
  assert.match(menu.message, /Org: Personal/);
  assert.ok(run.log.completed);
});

test("a rejected key asks again and is not saved", async () => {
  const route = api({ key: "sk-ant-sid01-wrongwrongwrongwrongwrong" });
  const run = await runScript({
    now: NOW,
    route: (url, headers) => headers.Cookie.includes("wrong") ? { status: 401, body: "" } : route(url, headers),
    alerts: [
      { title: "Claude session key", action: "Save", fields: ["sk-ant-sid01-wrongwrongwrongwrongwrong"] },
      { title: "Claude session key", action: "cancel" }
    ]
  });
  assert.match(run.log.alerts[1].message, /rejected that key/);
  assert.equal(run.keychain.size, 0);
});

test("an invalid paste asks again with a hint", async () => {
  const run = await runScript({
    now: NOW,
    route: api(),
    alerts: [
      { title: "Claude session key", action: "Save", fields: ["my password"] },
      { title: "Claude session key", action: "cancel" }
    ]
  });
  assert.match(run.log.alerts[1].message, /not a session key/);
  assert.equal(run.requests.length, 0);
});

test("offline during setup offers to save anyway", async () => {
  const run = await runScript({
    now: NOW,
    route: () => ({ throws: "offline" }),
    alerts: [
      { title: "Claude session key", action: "Save", fields: [KEY] },
      { title: "Could not check the key", action: "Save anyway" },
      { title: "Claude usage", action: "cancel" }
    ]
  });
  assert.equal(run.keychain.get("claude-usage-widget.session-key"), KEY);
  assert.match(run.log.alerts[2].message, /Offline/);
});

test("help button opens the guide", async () => {
  const run = await runScript({
    now: NOW,
    route: api(),
    alerts: [{ title: "Claude session key", action: "How do I get it?" }]
  });
  assert.equal(run.log.opened.length, 1);
  assert.match(run.log.opened[0], /#2-get-your-session-key$/);
});

test("menu: previews, refresh, replace and remove", async () => {
  const other = "sk-ant-sid01-otheraccountotheraccount00";
  const run = await runScript({
    now: NOW,
    keychain: KEYCHAIN,
    files: cache(),
    route: (url, headers) => api({ key: headers.Cookie.slice(11) })(url, headers),
    alerts: [
      { title: "Claude usage", action: "Preview rectangular widget" },
      { title: "Claude usage", action: "Preview circular widget" },
      { title: "Claude usage", action: "Preview inline widget" },
      { title: "Claude usage", action: "Refresh" },
      { title: "Claude usage", action: "Replace session key" },
      { title: "Claude session key", action: "Save", fields: [other] },
      { title: "Claude usage", action: "Remove session key" },
      { title: "Removed", action: "OK" }
    ]
  });
  assert.deepEqual(run.log.presented.map(([f]) => f),
    ["accessoryRectangular", "accessoryCircular", "accessoryInline"]);
  assert.equal(run.keychain.size, 0, "key removed");
  assert.equal(run.files.size, 0, "cache removed");
  assert.ok(run.requests.some((r) => r.headers.Cookie === `sessionKey=${other}`));
  assert.ok(run.log.completed);
});

test("cancelling the first prompt leaves nothing behind", async () => {
  const run = await runScript({ now: NOW, route: api(), alerts: [{ action: "cancel" }] });
  assert.equal(run.keychain.size, 0);
  assert.equal(run.requests.length, 0);
  assert.ok(run.log.completed);
});
