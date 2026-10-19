/**
 * Real-DOM integration test: jsdom + real React 18 + the real client bundle.
 *
 * Renders the pet through ReactDOM into a jsdom document, drives the session
 * event log, and asserts what actually lands in the DOM: the SVG character, the
 * mood attribute that drives the animation set, the speech bubble text, and the
 * WebAudio nodes the voice synthesizes when a turn completes.
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { JSDOM } = require("jsdom");
const React = require("react");
const ReactDOM = require("react-dom");
const { act } = require("react-dom/test-utils");

const PLUGIN = "dsh-plugin-xiaowu";

//#region ── jsdom environment ──
const dom = new JSDOM("<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>", {
	pretendToBeVisual: true,
	url: "http://127.0.0.1:3080/"
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
//#endregion

//#region ── the AudioContext instrument: record what the voice schedules ──
const audioCalls = [];
let audioTime = 0;
class FakeParam {
	constructor(name) {
		this.name = name;
		this.value = 0;
	}
	setValueAtTime(value, at) {
		audioCalls.push({ op: "setValueAtTime", name: this.name, value, at });
		return this;
	}
	linearRampToValueAtTime(value, at) {
		audioCalls.push({ op: "linearRamp", name: this.name, value, at });
		return this;
	}
	exponentialRampToValueAtTime(value, at) {
		audioCalls.push({ op: "expRamp", name: this.name, value, at });
		return this;
	}
}
class FakeNode {
	constructor(kind) {
		this.kind = kind;
		this.gain = new FakeParam("gain");
		this.frequency = new FakeParam("frequency");
		this.Q = new FakeParam("Q");
		this.pan = new FakeParam("pan");
		this.type = "sine";
		this.buffer = null;
		audioCalls.push({ op: "create", kind });
	}
	connect(target) {
		audioCalls.push({ op: "connect", from: this.kind, to: target === undefined ? "?" : target.kind ?? "destination" });
		return target;
	}
	start(at) {
		audioCalls.push({ op: "start", kind: this.kind, at });
	}
	stop(at) {
		audioCalls.push({ op: "stop", kind: this.kind, at });
	}
	getChannelData() {
		return new Float32Array(8);
	}
}class FakeAudioContext {
	constructor() {
		this.state = "running";
		this.sampleRate = 48000;
		this.currentTime = 0;
		this.destination = { kind: "destination" };
	}
	createGain() {
		return new FakeNode("gain");
	}
	createOscillator() {
		return new FakeNode("oscillator");
	}
	createBiquadFilter() {
		return new FakeNode("filter");
	}
	createStereoPanner() {
		return new FakeNode("panner");
	}
	createBufferSource() {
		return new FakeNode("bufferSource");
	}
	createBuffer(channels, frames, rate) {
		const data = new Float32Array(frames);
		return { length: frames, sampleRate: rate, numberOfChannels: channels, getChannelData: () => data };
	}
	resume() {
		this.state = "running";
		return Promise.resolve();
	}
}
window.AudioContext = FakeAudioContext;
//#endregion

//#region ── load the bundle through the module-loader facade ──
const staticModules = {
	react: React,
	"react-dom": ReactDOM,
	"react/jsx-runtime": require("react/jsx-runtime")
};
let registration = null;
window.__ModuleLoader__ = { load: (def) => { registration = def; } };
const source = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");
new Function("window", "document", "console", source)(window, window.document, console);
assert.ok(registration !== null, "bundle did not register");
const bundle = registration.factory((spec) => {
	if (spec in staticModules) return staticModules[spec];
	throw new Error("module not in table: " + spec);
});
//#endregion

//#region ── fake client context ──
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
		sessionId: id,
		queue: [],
		pendingSubmissions: [],
		running: false,
		subagent: null,
		removed: false,
		openState: "open",
		openError: null,
		hasMore: false,
		loadingOlder: false,
		promptError: null,
		blank: false,
		lastAgentError: null,
		promptAttempted: false,
		awaitingFirstTurn: false
	});
	const events = observable({ entries: [], hasMore: false, revision: 0, change: { kind: "replace", entries: [] } });
	const session = { sessionId: id, getSnapshot: store.getSnapshot, subscribe: store.subscribe, projections: { faceOf: () => observable(undefined) } };
	return {
		session,
		eventSource: events,
		push(event) {
			const current = events.getSnapshot();
			events.set({
				entries: [...current.entries, { type: "event", event }],
				hasMore: false,
				revision: current.revision + 1,
				change: { kind: "append", entries: [{ type: "event", event }] }
			});
		},
		setRunning(running) {
			store.set({ ...store.getSnapshot(), running });
		}
	};
}

let registered = null;
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
		bind() {
			return (key, params) => {
				const dict = {
					"detail.tool": "正在使用 {name}",
					"detail.thinking": "正在推理与撰写",
					"detail.idle": "空闲",
					"detail.done": "任务已完成",
					"detail.wait": "等待你的确认",
					"detail.oops": "上一轮出错了",
					"detail.sleep": "很久没有新动静",
					"state.idle": "待机中",
					"state.think": "认真思考中",
					"state.work": "努力干活中",
					"state.wait": "等你确认哦",
					"state.done": "做完啦……",
					"state.oops": "呜……出错了",
					"state.sleep": "睡着啦",
					"say.idle": "小舞在这里陪你～",
					"say.think": "小舞在想…",
					"say.work": "小舞在忙哦！",
					"say.wait": "小舞等你点头～",
					"say.done": "做完啦……",
					"say.oops": "呜……这里出错了",
					"say.sleep": "zzz…",
					"pet.name": "小舞",
					"pet.aria": "小舞，DSH 桌宠",
					"popover.hint": "点小舞可以摸摸她",
					"popover.pat": "呼哇～好舒服！"
				};
				let text = dict[key] ?? key;
				if (params !== undefined) for (const [k, v] of Object.entries(params)) text = text.replace("{" + k + "}", String(v));
				return text;
			};
		}
	},
	slots: {
		inject(key, callback) {
			callback();
			return () => {};
		},
		register(options, component) {
			registered = { options, component };
			return () => {};
		}
	},
	effect(fn) {
		fn();
		return () => {};
	},
	emit() {},
	on() {
		return () => {};
	}
};

bundle.apply(ctx);
assert.ok(registered !== null, "no slot registration");
assert.strictEqual(registered.options.name, "shell.overlay");
assert.strictEqual(registered.options.id, "xiaowu-pet");

// ── the build stamp: the one thing that tells a live page apart from a stale cache ──
assert.strictEqual(typeof bundle.build, "string", "the bundle must export its build stamp");
assert.ok(/^\d+\.\d+\.\d+$/.test(bundle.build), "build stamp must be semver-ish, got " + JSON.stringify(bundle.build));
assert.ok(window.__DSH_XIAOWU__ !== undefined, "apply() must publish window.__DSH_XIAOWU__");
assert.strictEqual(window.__DSH_XIAOWU__.build, bundle.build, "page stamp must equal the module stamp");
assert.strictEqual(window.__DSH_XIAOWU__.plugin, "dsh-plugin-xiaowu");
console.log("build stamp                -> " + bundle.build + " (window.__DSH_XIAOWU__ published)");
//#endregion

//#region ── real React render ──
const container = window.document.getElementById("root");
const root = ReactDOM.createRoot(container);
const Pet = registered.component;

function paint() {
	act(() => {
		root.render(React.createElement(Pet));
	});
}
function moodOf() {
	const node = container.querySelector(".dsh-xw-root");
	return node === null ? null : node.getAttribute("data-mood");
}
function bubbleText() {
	const node = container.querySelector(".dsh-xw-bubble");
	return node === null ? "" : node.textContent;
}

paint();
assert.ok(container.querySelector(".dsh-xw-root") !== null, "pet root did not mount");
assert.ok(container.querySelector("svg.dsh-xw-svg") !== null, "character SVG missing");
console.log("no session                 -> mood=" + moodOf() + " bubble=" + JSON.stringify(bubbleText()));
assert.strictEqual(moodOf(), "sleep", "with no session the pet should sleep");

const pet = makeSession("s1");
fixtures.set("s1", pet);
act(() => {
	listStore.set({
		...listStore.getSnapshot(),
		ids: ["s1"],
		byId: { s1: { id: "s1", displayTitle: "做一个桌宠", running: false, blank: false, updatedAt: Date.now() } },
		current: "s1"
	});
});
console.log("session opened             -> mood=" + moodOf());
assert.strictEqual(moodOf(), "idle");

function step(label, fn) {
	act(() => {
		paint();
	});
	act(() => {
		fn();
	});
	console.log(label.padEnd(26) + " -> mood=" + moodOf() + " bubble=" + JSON.stringify(bubbleText()));
	return moodOf();
}

const m1 = step("turn/start", () => {
	pet.setRunning(true);
	pet.push({ type: "turn/start", seq: 1, time: Date.now(), data: { turn: 1 } });
});
const m2 = step("tool/call(write)", () => pet.push({ type: "tool/call", seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: "c1", name: "write", arguments: "{}" } }));
const m3 = step("tool/result", () => pet.push({ type: "tool/result", seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: {} } }));
const m4 = step("approval/asked", () => pet.push({ type: "approval/asked", seq: 4, time: Date.now(), data: { requestId: "r1" } }));
const m5 = step("approval/decided", () => pet.push({ type: "approval/decided", seq: 5, time: Date.now(), data: { requestId: "r1", decision: "approve" } }));

audioCalls.length = 0;
const m6 = step("turn/end(success)", () => {
	pet.push({ type: "turn/end", seq: 6, time: Date.now(), data: { turn: 1, reason: "success" } });
	pet.setRunning(false);
});

assert.strictEqual(m1, "think");
assert.strictEqual(m2, "work");
assert.strictEqual(m3, "think");
assert.strictEqual(m4, "wait");
assert.strictEqual(m5, "think");
assert.strictEqual(m6, "done");
assert.strictEqual(bubbleText(), "做完啦……", "the completion bubble must say 做完啦……");

// the tool chip carries the tool face while working
paint();
const chipText = container.querySelector(".dsh-xw-chip").textContent;
assert.ok(chipText.includes("write"), "tool chip lost the tool name, got " + JSON.stringify(chipText));

// ── the synthesized voice: a multi-note phrase with FM, a breath burst and a bell tail ──
const oscillators = audioCalls.filter((call) => call.op === "create" && call.kind === "oscillator").length;
const buffers = audioCalls.filter((call) => call.op === "create" && call.kind === "bufferSource").length;
const starts = audioCalls.filter((call) => call.op === "start").length;
const fmRamps = audioCalls.filter((call) => call.op === "expRamp" && call.name === "frequency").length;
console.log("\ncompletion audio           -> oscillators=" + oscillators + " noiseBursts=" + buffers + " noteStarts=" + starts + " fmGlides=" + fmRamps);
assert.ok(oscillators >= 16, "the phrase should layer many oscillators, got " + oscillators);
assert.ok(buffers >= 4, "each syllable should get a breath burst, got " + buffers);
assert.ok(fmRamps >= 4, "each syllable should glide in pitch, got " + fmRamps);

// ── the mute button flips persistence and stops scheduling ──
const muteButton = container.querySelector(".dsh-xw-btn");
assert.ok(muteButton !== null, "no mute button");
act(() => {
	muteButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
assert.strictEqual(window.localStorage.getItem("dsh-plugin-xiaowu:audio"), "off", "mute must persist");
audioCalls.length = 0;
act(() => {
	pet.setRunning(true);
	pet.push({ type: "turn/start", seq: 7, time: Date.now(), data: { turn: 2 } });
	pet.push({ type: "turn/end", seq: 8, time: Date.now(), data: { turn: 2, reason: "success" } });
	pet.setRunning(false);
});
assert.strictEqual(audioCalls.length, 0, "muted pet must schedule no audio");
console.log("mute toggle                -> persisted 'off', scheduled nodes after mute=" + audioCalls.length);

// ── style tag, and the completion sound after unmuting ──
const style = window.document.getElementById(PLUGIN + ":style");
assert.ok(style !== null, "stylesheet was not injected");
assert.ok(style.textContent.includes("@keyframes xw-jump"), "stylesheet lost the animation keyframes");
function clickMute() {
	act(() => {
		container.querySelector(".dsh-xw-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	});
}
function finishTurn(turn, seq) {
	act(() => {
		pet.setRunning(true);
		pet.push({ type: "turn/start", seq, time: Date.now(), data: { turn } });
		pet.push({ type: "turn/end", seq: seq + 1, time: Date.now(), data: { turn, reason: "success" } });
		pet.setRunning(false);
	});
}
clickMute(); // unmute
assert.strictEqual(window.localStorage.getItem("dsh-plugin-xiaowu:audio"), "on", "unmute must persist");
// the earlier completion hold is still live, so spend it first, then leave the
// "done" mood and complete a fresh turn so the mood edge actually fires.
finishTurn(3, 9);
act(() => {
	pet.setRunning(true);
	pet.push({ type: "turn/start", seq: 11, time: Date.now(), data: { turn: 4 } });
});
audioCalls.length = 0;
finishTurn(4, 12);
console.log("unmute + completion        -> scheduled nodes=" + audioCalls.length);
assert.ok(audioCalls.length > 20, "unmuted completion should schedule the phrase");
assert.strictEqual(moodOf(), "done");
assert.strictEqual(bubbleText(), "做完啦……");

// ── poke interaction ──
act(() => {
	container.querySelector(".dsh-xw-stage").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
assert.ok(container.querySelector(".dsh-xw-root").className.includes("is-poked"), "poking must add the hop class");
console.log("poke                       -> class=" + container.querySelector(".dsh-xw-root").className);

// ── anchor + pointer-events contract for the click-through overlay layer ──
const css = style.textContent;
assert.ok(/\.dsh-xw-root\{[^}]*position:fixed/.test(css), "pet root must be fixed positioned");
assert.ok(/\.dsh-xw-root\{[^}]*bottom:/.test(css), "pet root must be anchored to the bottom");
assert.ok(/\.dsh-xw-root\{[^}]*right:/.test(css), "pet root must be anchored to the right");
assert.ok(/\.dsh-xw-stage\{[^}]*pointer-events:auto/.test(css), "pet must opt back into pointer events");

console.log("\nOK: jsdom + real React render mounts the pet, every mood reaches the DOM,");
console.log("    the completion bubble says 做完啦……, and the voice synthesizes a phrase.");

// jsdom keeps its event loop alive; the assertions above are the whole contract.
act(() => {
	root.unmount();
});
process.exit(0);
