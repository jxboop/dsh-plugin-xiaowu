/**
 * Render the character at every mood into a standalone preview HTML page.
 *
 * Uses jsdom + real React to mount the pet (same path as test/dom.cjs), then
 * serializes the markup into one page per mood so the art can be eyeballed in a
 * browser without running the GUI.
 *
 * Usage: node test/preview.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const React = require("react");
const ReactDOM = require("react-dom");
const { act } = require("react-dom/test-utils");

const dom = new JSDOM("<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>", {
	pretendToBeVisual: true,
	url: "http://127.0.0.1:3080/"
});
const { window } = dom;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
	globalThis[key] = key === "window" ? window : key === "document" ? window.document : key === "navigator" ? window.navigator : window[key];
}
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const staticModules = {
	react: React,
	"react-dom": ReactDOM,
	"react/jsx-runtime": require("react/jsx-runtime")
};
let registration = null;
window.__ModuleLoader__ = { load: (def) => { registration = def; } };
new Function("window", "document", "console", fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8"))(window, window.document, console);
const bundle = registration.factory((spec) => {
	if (spec in staticModules) return staticModules[spec];
	throw new Error("module not in table: " + spec);
});

function observable(initial) {
	let value = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		}
	};
}

const fixtures = new Map();
const listStore = observable({ ids: [], byId: {}, current: undefined, phase: "ready", subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined });
function makeSession(id) {
	const store = observable({
		sessionId: id, queue: [], pendingSubmissions: [], running: false, subagent: null, removed: false,
		openState: "open", openError: null, hasMore: false, loadingOlder: false, promptError: null,
		blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false
	});
	const events = observable({ entries: [], hasMore: false, revision: 0, change: { kind: "replace", entries: [] } });
	return {
		session: { sessionId: id, getSnapshot: store.getSnapshot, subscribe: store.subscribe, projections: { faceOf: () => observable(undefined) } },
		eventSource: events,
		push(event) {
			const current = events.getSnapshot();
			events.set({ entries: [...current.entries, { type: "event", event }], hasMore: false, revision: current.revision + 1, change: { kind: "append", entries: [] } });
		},
		setRunning(running) {
			store.set({ ...store.getSnapshot(), running });
		}
	};
}

let registered = null;
const zh = {
	"state.idle": "待机中", "state.think": "认真思考中", "state.work": "努力干活中", "state.wait": "等你确认哦",
	"state.done": "做完啦……", "state.oops": "呜……出错了", "state.sleep": "睡着啦",
	"say.idle": "小舞在这里陪你～", "say.think": "小舞在想…", "say.work": "小舞在忙哦！", "say.wait": "小舞等你点头～",
	"say.done": "做完啦……", "say.oops": "呜……这里出错了", "say.sleep": "zzz…",
	"detail.tool": "正在使用 {name}", "detail.thinking": "正在推理与撰写", "detail.idle": "空闲",
	"detail.done": "任务已完成", "detail.wait": "等待你的确认", "detail.oops": "上一轮出错了",
	"detail.sleep": "很久没有新动静", "pet.name": "小舞", "pet.aria": "小舞，DSH 桌宠",
	"popover.hint": "点小舞可以摸摸她", "popover.pat": "呼哇～好舒服！"
};
const ctx = {
	sessions: {
		list: listStore,
		binding(id) {
			const fixture = fixtures.get(id);
			return fixture === undefined ? undefined : { sessionId: id, session: fixture.session, eventSource: fixture.eventSource, ctx: {} };
		}
	},
	locale: {
		register() {
			return () => {};
		},
		bind: () => (key, params) => {
			let text = zh[key] ?? key;
			if (params !== undefined) for (const [k, v] of Object.entries(params)) text = text.replace("{" + k + "}", String(v));
			return text;
		}
	},
	slots: {
		inject: (key, callback) => {
			callback();
			return () => {};
		},
		register: (options, component) => {
			registered = { options, component };
			return () => {};
		}
	},
	effect(fn) {
		fn();
		return () => {};
	},
	emit() {},
	on: () => () => {}
};

bundle.apply(ctx);
const container = window.document.getElementById("root");
const root = ReactDOM.createRoot(container);
const paint = () => act(() => root.render(React.createElement(registered.component)));

const scenarios = [];
function snapshotOf(label, setup) {
	setup();
	paint();
	const rootNode = container.querySelector(".dsh-xw-root");
	scenarios.push({ label, mood: rootNode.getAttribute("data-mood"), html: container.innerHTML });
}

snapshotOf("sleep 睡着", () => {});
const pet = makeSession("s1");
fixtures.set("s1", pet);
snapshotOf("idle 待机", () => {
	listStore.set({ ...listStore.getSnapshot(), ids: ["s1"], byId: { s1: { id: "s1", displayTitle: "做一个桌宠插件", running: false, blank: false, updatedAt: Date.now() } }, current: "s1" });
});
snapshotOf("think 思考", () => {
	pet.setRunning(true);
	pet.push({ type: "turn/start", seq: 1, time: Date.now(), data: { turn: 1 } });
});
snapshotOf("work 干活", () => {
	pet.push({ type: "tool/call", seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: "c1", name: "write", arguments: "{}" } });
});
snapshotOf("wait 等确认", () => {
	pet.push({ type: "tool/result", seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: {} } });
	pet.push({ type: "approval/asked", seq: 4, time: Date.now(), data: { requestId: "r1" } });
});
snapshotOf("done 完成", () => {
	pet.push({ type: "approval/decided", seq: 5, time: Date.now(), data: { requestId: "r1", decision: "approve" } });
	pet.push({ type: "turn/end", seq: 6, time: Date.now(), data: { turn: 1, reason: "success" } });
	pet.setRunning(false);
});
snapshotOf("oops 出错", () => {
	pet.setRunning(true);
	pet.push({ type: "turn/start", seq: 7, time: Date.now(), data: { turn: 2 } });
	pet.push({ type: "turn/end", seq: 8, time: Date.now(), data: { turn: 2, reason: "error" } });
	pet.setRunning(false);
});

const style = window.document.getElementById("dsh-plugin-xiaowu:style").textContent;
const cards = scenarios
	.map(
		(scenario, index) => `  <figure class="card">
    <figcaption>${scenario.label} <code>data-mood="${scenario.mood}"</code></figcaption>
    <div class="stage">${scenario.html.replace(/class="dsh-xw-root/g, 'class="dsh-xw-root xw-frozen-' + index)}</div>
  </figure>`
	)
	.join("\n");

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>小舞 · 桌宠形象预览</title>
<style>
${style}
body{margin:0;padding:28px;background:#f6f2f6;color:#4a2237;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:18px;margin:0 0 4px}
p.note{margin:0 0 22px;color:#8a6a7a}
.grid{display:flex;flex-wrap:wrap;gap:18px}
.card{margin:0;padding:8px 12px 4px;background:#fff;border-radius:16px;box-shadow:0 6px 18px rgba(150,80,120,.14);min-width:220px}
figcaption{margin-bottom:6px;color:#8a3355;font-size:12px}
figcaption code{color:#a05f7f}
/* The preview shows each mood standing still: freeze animations at a nice frame. */
.stage{position:relative;height:190px}
.stage .dsh-xw-root{position:absolute!important;right:8px;bottom:8px;left:auto!important;top:auto!important}
.stage .dsh-xw-root *{animation-play-state:paused!important}
</style>
</head>
<body>
<h1>小舞 · DSH 桌宠形象预览</h1>
<p class="note">由 <code>test/preview.cjs</code> 生成：真实 React 渲染的每一个心情状态（角色为原创 SVG 绘制）。</p>
<div class="grid">
${cards}
</div>
</body>
</html>
`;

const out = path.join(__dirname, "..", "preview.html");
fs.writeFileSync(out, page, "utf8");
console.log("wrote " + out + " (" + page.length + " bytes, " + scenarios.length + " moods: " + scenarios.map((s) => s.mood).join(", ") + ")");

// A second page: the same markup at 4x, one card per mood, for eyeballing the art.
const zoomCards = scenarios
	.map(
		(scenario) => `  <figure class="cell">
    <figcaption>${scenario.label}</figcaption>
    <div class="frame zoom">${scenario.html.replace(/class="dsh-xw-root/g, 'class="dsh-xw-root xw-freeze-1')}</div>
  </figure>`
	)
	.join("\n");
const zoomPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>小舞 · 放大细看</title>
<style>${style}</style>
<style>
body{margin:0;padding:26px;background:#fdf7fa;color:#5b2a3d;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:17px;margin:0 0 16px}
.grid{display:flex;gap:30px;flex-wrap:wrap;align-items:flex-start}
.cell{margin:0;text-align:center}
figcaption{margin-bottom:8px;color:#a05f7f;font-size:13px}
.frame{background:#fff;border-radius:16px;padding:12px;box-shadow:0 8px 22px rgba(150,80,120,.15);zoom:4.2}
.frame .dsh-xw-root{position:static!important;display:inline-flex!important;right:auto!important;bottom:auto!important}
</style>
</head>
<body>
<h1>小舞 · 放大细看（真实浏览器渲染的 SVG 角色）</h1>
<div class="grid">
${zoomCards}
</div>
</body>
</html>
`;
const zoomOut = path.join(__dirname, "..", "preview-zoom.html");
fs.writeFileSync(zoomOut, zoomPage, "utf8");
console.log("wrote " + zoomOut + " (" + zoomPage.length + " bytes)");

act(() => root.unmount());
process.exit(0);
