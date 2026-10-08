// Runs the real script against the real claude.ai API (through the Scriptable
// mock) and prints what each lock screen widget would show.
//
//   CLAUDE_SESSION_KEY=sk-ant-sid01-... node test/live-check.js
//
// Node's TLS fingerprint differs from iOS, so a Cloudflare block here does not
// prove the phone gets blocked too. A success here does prove the API shape.

const { runScript, texts } = require("./scriptable-mock");

const key = (process.env.CLAUDE_SESSION_KEY || "").trim();
if (!key) {
  console.error("Set CLAUDE_SESSION_KEY to the value of your claude.ai sessionKey cookie.");
  process.exit(2);
}

async function route(url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: "manual" });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { throws: e.message };
  }
}

(async () => {
  const files = {};
  for (const family of ["accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
    const run = await runScript({
      family,
      route,
      files,
      keychain: { "claude-usage-widget.session-key": key }
    });
    Object.assign(files, Object.fromEntries(run.files));
    console.log(`${family.padEnd(22)} ${texts(run.log.widgets[0]).join(" | ")}`);
  }
  const cache = files["/docs/claude-usage-widget-cache.json"];
  console.log(cache ? `\nParsed: ${JSON.stringify(JSON.parse(cache).usage)}` : "\nNo usage fetched.");
})();
