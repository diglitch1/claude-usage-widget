// Minimal, strict stand-in for the Scriptable runtime, so the widget script can
// run under Node. Every class only accepts the properties and methods listed in
// the Scriptable docs: using anything else throws, which catches API typos that
// a permissive mock would hide.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT = path.join(__dirname, "..", "claude-usage.js");

// Bookkeeping fields the mock itself writes; never reachable from the script's
// point of view as documented API, but they must not trip the strict check.
const INTERNAL = new Set(["layout", "align", "padding", "cancel", "fields"]);

function strict(target, props) {
  for (const prop of props) {
    if (!(prop in target)) {
      target[prop] = null;
    }
  }
  return new Proxy(target, {
    set(obj, key, value) {
      if (!props.includes(key) && !INTERNAL.has(key)) {
        throw new Error(`${obj.constructor.name}.${String(key)} is not a Scriptable property`);
      }
      obj[key] = value;
      return true;
    },
    get(obj, key) {
      if (typeof key === "symbol" || key === "then" || key in obj) {
        return obj[key];
      }
      throw new Error(`${obj.constructor.name}.${String(key)} does not exist in Scriptable`);
    }
  });
}

function createRuntime(options = {}) {
  const log = { widgets: [], alerts: [], presented: [], opened: [], completed: false };
  const keychain = new Map(Object.entries(options.keychain || {}));
  const files = new Map(Object.entries(options.files || {}));
  const alertQueue = [...(options.alerts || [])];
  const requests = [];

  class Size { constructor(w, h) { this.width = w; this.height = h; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Rect { constructor(x, y, w, h) { Object.assign(this, { x, y, width: w, height: h }); } }

  class Color {
    constructor(hex, alpha = 1) {
      if (!/^#?[0-9a-f]{6}$/i.test(hex)) throw new Error(`bad color ${hex}`);
      this.hex = hex.replace("#", "").toUpperCase();
      this.alpha = alpha;
    }
    static white() { return new Color("#FFFFFF"); }
    static black() { return new Color("#000000"); }
  }

  const fontFactory = (weight) => (size) => {
    if (typeof size !== "number") throw new Error("font size must be a number");
    return { weight, size };
  };
  const Font = {
    systemFont: fontFactory("regular"),
    mediumSystemFont: fontFactory("medium"),
    semiboldSystemFont: fontFactory("semibold"),
    boldSystemFont: fontFactory("bold"),
    mediumRoundedSystemFont: fontFactory("medium-rounded"),
    semiboldRoundedSystemFont: fontFactory("semibold-rounded"),
    boldRoundedSystemFont: fontFactory("bold-rounded")
  };

  class Image { constructor(ops) { this.ops = ops; } }

  class Path {
    constructor() { this.ops = []; return strict(this, []); }
    move(p) { this.ops.push(["move", p]); }
    addLine(p) { this.ops.push(["line", p]); }
    addRoundedRect(rect, cw, ch) { this.ops.push(["rrect", rect, cw, ch]); }
    closeSubpath() { this.ops.push(["close"]); }
  }

  class DrawContext {
    constructor() {
      this.ops = [];
      return strict(this, ["size", "respectScreenScale", "opaque"]);
    }
    addPath(p) { this.ops.push(["path", p.ops]); }
    fillPath() { this.ops.push(["fill"]); }
    strokePath() { this.ops.push(["stroke"]); }
    setFillColor(c) { this.ops.push(["fillColor", c]); }
    setStrokeColor(c) { this.ops.push(["strokeColor", c]); }
    setLineWidth(w) { this.ops.push(["lineWidth", w]); }
    getImage() {
      if (!this.size) throw new Error("DrawContext.size not set");
      return new Image(this.ops);
    }
  }

  const TEXT_PROPS = ["text", "textColor", "font", "textOpacity", "lineLimit",
    "minimumScaleFactor", "shadowColor", "shadowRadius", "shadowOffset", "url"];
  class WidgetText {
    constructor(text) { this.kind = "text"; this.text = text; return strict(this, TEXT_PROPS); }
    leftAlignText() { this.align = "left"; }
    centerAlignText() { this.align = "center"; }
    rightAlignText() { this.align = "right"; }
  }
  class WidgetImage {
    constructor(image) {
      if (!(image instanceof Image)) throw new Error("addImage needs an Image");
      this.kind = "image";
      this.image = image;
      return strict(this, ["image", "resizable", "imageSize", "imageOpacity", "cornerRadius",
        "borderWidth", "borderColor", "containerRelativeShape", "tintColor", "url"]);
    }
  }
  class WidgetSpacer {
    constructor(length) { this.kind = "spacer"; this.length = length ?? null; return strict(this, ["length"]); }
  }

  const CONTAINER_PROPS = ["backgroundColor", "backgroundImage", "backgroundGradient", "spacing", "url"];
  class Container {
    addText(text) {
      if (typeof text !== "string") throw new Error("addText needs a string");
      return this.push(new WidgetText(text));
    }
    addImage(image) { return this.push(new WidgetImage(image)); }
    addSpacer(length) { return this.push(new WidgetSpacer(length)); }
    addStack() { return this.push(new WidgetStack()); }
    setPadding(t, l, b, r) { this.padding = [t, l, b, r]; }
    push(item) { this.children.push(item); return item; }
  }

  class WidgetStack extends Container {
    constructor() {
      super();
      this.kind = "stack";
      this.children = [];
      return strict(this, [...CONTAINER_PROPS, "size", "cornerRadius", "borderWidth", "borderColor"]);
    }
    layoutHorizontally() { this.layout = "h"; }
    layoutVertically() { this.layout = "v"; }
    topAlignContent() {}
    centerAlignContent() { this.align = "center"; }
    bottomAlignContent() {}
  }

  class ListWidget extends Container {
    constructor() {
      super();
      this.kind = "widget";
      this.children = [];
      return strict(this, [...CONTAINER_PROPS, "refreshAfterDate", "addAccessoryWidgetBackground"]);
    }
    async presentSmall() { log.presented.push(["small", this]); }
    async presentAccessoryRectangular() { log.presented.push(["accessoryRectangular", this]); }
    async presentAccessoryCircular() { log.presented.push(["accessoryCircular", this]); }
    async presentAccessoryInline() { log.presented.push(["accessoryInline", this]); }
  }

  class Request {
    constructor(url) {
      this.url = url;
      return strict(this, ["url", "method", "headers", "body", "timeoutInterval", "response"]);
    }
    async loadString() {
      requests.push({ url: this.url, headers: this.headers });
      const route = options.route ? await options.route(this.url, this.headers) : null;
      if (!route) throw new Error(`no route for ${this.url}`);
      if (route.throws) throw new Error(route.throws);
      this.response = { statusCode: route.status ?? 200 };
      return typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    }
  }

  class Alert {
    constructor() {
      this.actions = [];
      this.fields = [];
      return strict(this, ["title", "message"]);
    }
    addAction(t) { this.actions.push(t); }
    addDestructiveAction(t) { this.actions.push(t); }
    addCancelAction(t) { this.cancel = t; }
    addTextField(placeholder, text) { this.fields.push(text || ""); }
    addSecureTextField(placeholder, text) { this.fields.push(text || ""); }
    async presentAlert() { return this.answer("alert"); }
    async presentSheet() { return this.answer("sheet"); }
    answer(style) {
      log.alerts.push({ style, title: this.title, message: this.message, actions: this.actions });
      const next = alertQueue.shift();
      if (!next) throw new Error(`unexpected alert: ${this.title}`);
      if (next.title && next.title !== this.title) {
        throw new Error(`expected alert "${next.title}", got "${this.title}"`);
      }
      this.fields = next.fields || this.fields;
      if (typeof next.action === "string") {
        if (next.action === "cancel") return -1;
        const index = this.actions.indexOf(next.action);
        if (index === -1) throw new Error(`no action "${next.action}" in ${this.actions}`);
        return index;
      }
      return next.choice;
    }
    textFieldValue(i) { return this.fields[i]; }
  }

  const Keychain = {
    contains: (k) => keychain.has(k),
    get: (k) => { if (!keychain.has(k)) throw new Error("missing key"); return keychain.get(k); },
    set: (k, v) => { keychain.set(k, v); },
    remove: (k) => { keychain.delete(k); }
  };

  const fm = {
    documentsDirectory: () => "/docs",
    joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => files.has(p),
    readString: (p) => files.get(p),
    writeString: (p, s) => { files.set(p, s); },
    remove: (p) => { files.delete(p); }
  };

  const context = {
    console,
    ListWidget, Size, Point, Rect, Color, Font, Path, DrawContext, Request, Alert, Keychain,
    FileManager: { local: () => fm },
    Safari: { open: (url) => log.opened.push(url) },
    Script: {
      name: () => "Claude Usage",
      setWidget: (w) => log.widgets.push(w),
      complete: () => { log.completed = true; }
    },
    config: {
      runsInWidget: Boolean(options.family),
      runsInAccessoryWidget: Boolean(options.family && options.family.startsWith("accessory")),
      widgetFamily: options.family || null
    },
    args: { widgetParameter: options.parameter ?? null }
  };
  if (options.now) {
    const RealDate = Date;
    const fixed = options.now;
    context.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fixed])); }
      static now() { return fixed; }
    };
  }
  if (options.hook) {
    context.__CLAUDE_USAGE_TEST__ = options.hook;
  }

  return { context, log, keychain, files, requests, alertQueue };
}

async function runScript(options = {}) {
  const runtime = createRuntime(options);
  const source = fs.readFileSync(SCRIPT, "utf8");
  const wrapped = `(async () => {\n${source}\n})()`;
  await vm.runInNewContext(wrapped, runtime.context, { filename: SCRIPT });
  return runtime;
}

async function loadHelpers(options = {}) {
  let helpers;
  await runScript({ ...options, hook: (h) => { helpers = h; } });
  return helpers;
}

// Flattens a widget tree to its visible strings, in order.
function texts(node) {
  const out = [];
  const walk = (n) => {
    if (n.kind === "text") out.push(n.text);
    for (const child of "children" in n ? n.children : []) walk(child);
  };
  walk(node);
  return out;
}

module.exports = { runScript, loadHelpers, texts };
