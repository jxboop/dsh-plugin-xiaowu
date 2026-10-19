/**
 * Mount harness for the xiaowu pet client bundle.
 *
 * Loads lib/client.js with a faked `window.__ModuleLoader__`, a fake React and a
 * fake client Cordis context, then drives the session event log through a few
 * scripted turns and prints the pet's mood after each one. This is the
 * no-browser check that the bundle materializes, registers into shell.overlay,
 * and derives the right mood from real event shapes.
 */
const path = require("node:path");
const assert = require("node:assert");

//#region ── a React small enough to run the component once ──
let hooks = [];
let hookIndex = 0;
let pendingEffects = [];
let currentRender = null;

function makeHookSlot() {
	const i = hookIndex++;
	if (hooks[i] === undefined) hooks[i] = { value: undefined, deps: undefined };
	return hooks[i];
}

const React = {
	createElement(type, props, ...children) {
		const flat = [];
		for (const child of children) {
			if (Array.isArray(child)) flat.push(...child);
			else if (child === null || child === undefined || child === false) continue;
			else flat.push(child);
		}
		return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat } };
	},
	useRef(initial) {
		const slot = makeHookSlot();
		if (slot.value === undefined) slot.value = { current: initial };
		return slot.value;
	},
	useState(initial) {
		const slot = makeHookSlot();
		if (slot.value === undefined) slot.value = typeof initial === "function" ? initial() : initial;
		const set = (next) => {
			slot.value = typeof next === "function" ? next(slot.value) : next;
		};
		return [slot.value, set];
	},
	useCallback(fn, deps) {
		const slot = makeHookSlot();
		const same = slot.deps !== undefined && deps !== undefined && slot.deps.length === deps.length && slot.deps.every((d, i) => d === deps[i]);
		if (!same) {
			slot.value = fn;
			slot.deps = deps;
		}
		return slot.value;
	},
	useMemo(fn, deps) {
		const slot = makeHookSlot();
		const same = slot.deps !== undefined && deps !== undefined && slot.deps.length === deps.length && slot.deps.every((d, i) => d === deps[i]);
		if (!same) {
			slot.value = fn();
			slot.deps = deps;
		}
		return slot.value;
	},
	useEffect(fn, deps) {
		const slot = makeHookSlot();
		const same = slot.deps !== undefined && deps !== undefined && slot.deps.length === deps.length && slot.deps.every((d, i) => d === deps[i]);
		if (!same) {
			slot.deps = deps;
			pendingEffects.push(fn);
		}
	},
	useSyncExternalStore(subscribe, getSnapshot) {
		const slot = makeHookSlot();
		if (slot.value === undefined) {
			slot.value = { value: getSnapshot(), unsub: subscribe(() => {}) };
		}
		slot.value.value = getSnapshot();
		return slot.value.value;
	},
	useLayoutEffect(fn, deps) {
		React.useEffect(fn, deps);
	},
	Component: class {},
	createContext: () => ({ Provider: null, Consumer: null }),
};

const ReactDOM = { createPortal: (node) => node };
//#endregion

//#region ── a fake DOM good enough for the component body ──
class FakeNode {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.attributes = {};
		this.style = {};
		this.dataset = {};
		this.textContent = "";
		this.className = "";
		this.listeners = {};
		this.parent = null;
	}
	appendChild(child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}
	setAttribute(name, value) {
		this.attributes[name] = value;
	}
	getAttribute(name) {
		return this.attributes[name];
	}
	addEventListener() {}
	removeEventListener() {}
	remove() {
		if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
	}
	querySelector() {
		return null;
	}
	querySelectorAll() {
		return [];
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 112, height: 112 };
	}
}
const documentStub = {
	head: new FakeNode("head"),
	body: new FakeNode("body"),
	getElementById() {
		return null;
	},
	createElement(tag) {
		return new FakeNode(tag);
	},
	addEventListener() {},
	removeEventListener() {},
};

const windowStub = {
	document: documentStub,
	localStorage: {
		store: new Map(),
		getItem(key) {
			return this.store.has(key) ? this.store.get(key) : null;
		},
		setItem(key, value) {
			this.store.set(key, String(value));
		},
	},
	addEventListener() {},
	removeEventListener() {},
	setInterval: () => 1,
	clearInterval() {},
	setTimeout: () => 1,
	clearTimeout() {},
	requestAnimationFrame: () => 1,
	cancelAnimationFrame() {},
};
//#endregion

//#region ── module table + loader facade ──
const staticModules = {
	react: React,
	"react-dom": ReactDOM,
	"react/jsx-runtime": { jsx: React.createElement, jsxs: React.createElement },
};

let registration = null;
const windowObject = {
	...windowStub,
	AudioContext: undefined,
	__ModuleLoader__: {
		load(def) {
			registration = def;
		},
	},
};
windowObject.window = windowObject;

const clientPath = path.join(__dirname, "..", "lib", "client.js");
const source = require("node:fs").readFileSync(clientPath, "utf8");
const run = new Function("window", "console", "setTimeout", "clearTimeout", "Math", "Date", source);
run(windowObject, console, windowStub.setTimeout, windowStub.clearTimeout, Math, Date);

assert.ok(registration !== null, "bundle did not register with __ModuleLoader__");
assert.strictEqual(registration.id, "dsh-plugin-xiaowu", "unexpected bundle id: " + registration.id);
const exports_ = registration.factory((spec) => {
	if (spec in staticModules) return staticModules[spec];
	throw new Error("module not in table: " + spec);
});
assert.strictEqual(typeof exports_.apply, "function", "bundle exports no apply()");
assert.ok(Array.isArray(exports_.inject), "bundle exports no inject list");
//#endregion

//#region ── fake client context ──
function makeObservable(initial) {
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
		},
	};
}

function makeSession(id, title) {
	const snapshot = {
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
		awaitingFirstTurn: false,
	};
	const store = makeObservable(snapshot);
	const events = makeObservable({ entries: [], hasMore: false, revision: 0, change: { kind: "replace", entries: [] } });
	const session = {
		sessionId: id,
		getSnapshot: store.getSnapshot,
		subscribe: store.subscribe,
		projections: { faceOf: () => makeObservable(undefined) },
	};
	return {
		id,
		title,
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
		},
		setError(message) {
			store.set({ ...store.getSnapshot(), lastAgentError: message });
		}
	};
}

const sessionsStore = makeObservable({ ids: [], byId: {}, current: undefined, phase: "ready", subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined });
const fixtures = new Map();

const ctx = {
	sessions: {
		list: sessionsStore,
		binding(id) {
			const f = fixtures.get(id);
			if (f === undefined) return undefined;
			return { sessionId: id, session: f.session, eventSource: f.eventSource, ctx: {} };
		}
	},
	locale: {
		register() {
			return () => {};
		},
		bind() {
			return (key, params) => {
				const dict = { "detail.tool": "正在使用 {name}" };
				let text = dict[key] ?? key;
				if (params !== undefined) {
					for (const [k, v] of Object.entries(params)) text = text.replace("{" + k + "}", String(v));
				}
				return text;
			};
		}
	},
	slots: {
		inject(key, callback) {
			assert.strictEqual(key, "shell.overlay", "pet must target shell.overlay, got " + key);
			callback();
			return () => {};
		},
		register(options, component) {
			registeredSlot = { options, component };
			return () => {};
		}
	},
	effect(fn, label) {
		const disposer = fn();
		effects.push({ label, disposer });
		return () => {};
	},
	emit() {},
	on() {
		return () => {};
	}
};

let registeredSlot = null;
const effects = [];

//#endregion

//#region ── run it ──
exports_.apply(ctx);

assert.ok(registeredSlot !== null, "no slot registration happened");
assert.strictEqual(registeredSlot.options.name, "shell.overlay");
assert.strictEqual(registeredSlot.options.id, "xiaowu-pet");
assert.strictEqual(typeof registeredSlot.component, "function");

// render once to bind the follow store to the component
hooks = [];
hookIndex = 0;
pendingEffects = [];
let tree = expand(registeredSlot.component({}));
assert.ok(tree !== null && tree.type === "div", "component did not render a root div");
assert.strictEqual(tree.props["data-mood"], "sleep", "with no session the pet should be asleep, got " + tree.props["data-mood"]);
for (const effect of pendingEffects.splice(0)) effect();

// open a session
const pet = makeSession("s1", "做一个桌宠");
fixtures.set("s1", pet);
sessionsStore.set({ ...sessionsStore.getSnapshot(), ids: ["s1"], byId: { s1: { id: "s1", displayTitle: "做一个桌宠", running: false, blank: false, updatedAt: Date.now() } }, current: "s1" });

function renderPet() {
	hooks = [];
	hookIndex = 0;
	pendingEffects = [];
	return expand(registeredSlot.component({}));
}
function mood() {
	return renderPet().props["data-mood"];
}

/** Expand function components so assertions read the host tree. */
function expand(node) {
	let current = node;
	for (let i = 0; i < 12 && current !== null && typeof current === "object" && typeof current.type === "function"; i += 1) {
		current = current.type(current.props ?? {});
	}
	return current;
}

const steps = [];
steps.push(["idle (session open, nothing running)", mood()]);

pet.setRunning(true);
pet.push({ type: "turn/start", seq: 1, time: Date.now(), data: { turn: 1 } });
steps.push(["think (turn started)", mood()]);

pet.push({ type: "tool/call", seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: "c1", name: "pwsh", arguments: "{}" } });
const workTree = renderPet();
steps.push(["work (pwsh running)", workTree.props["data-mood"]]);

pet.push({ type: "tool/result", seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: {} } });
steps.push(["think (tool returned)", mood()]);

pet.push({ type: "approval/asked", seq: 4, time: Date.now(), data: { requestId: "r1" } });
steps.push(["wait (approval asked)", mood()]);

pet.push({ type: "approval/decided", seq: 5, time: Date.now(), data: { requestId: "r1", decision: "approve" } });
steps.push(["think (approval decided)", mood()]);

pet.push({ type: "turn/end", seq: 6, time: Date.now(), data: { turn: 1, reason: "success" } });
pet.setRunning(false);
steps.push(["done (turn ended)", mood()]);

pet.setRunning(true);
pet.push({ type: "turn/start", seq: 7, time: Date.now(), data: { turn: 2 } });
pet.push({ type: "assistant/attempt", seq: 8, time: Date.now(), data: { turn: 2, step: 1, stream: [] } });
pet.push({ type: "turn/end", seq: 9, time: Date.now(), data: { turn: 2, reason: "error" } });
pet.setRunning(false);
if (process.env.XW_DEBUG === "1") {
	const st = followState();
	console.error("DEBUG oops step:", JSON.stringify(st));
}
steps.push(["oops (turn failed)", mood()]);

console.log("event-log walk:");
for (const [label, actual] of steps) console.log("  " + label.padEnd(34) + " -> " + actual);

const expected = ["idle", "think", "work", "think", "wait", "think", "done", "oops"];
const actual = steps.map(([, m]) => m);
assert.deepStrictEqual(actual, expected, "mood sequence mismatch\n  expected " + JSON.stringify(expected) + "\n  actual   " + JSON.stringify(actual));

// the tool chip must carry the tool face
assert.ok(String(workTree.props.children[2].props.children[0].props.children).includes("pwsh"), "tool chip lost the tool name");

// ── a second, direct pass over the follow store itself (no React in the way) ──
// A fresh session keeps this walk independent of the flow above.
const pet2 = makeSession("s2", "第二个会话");
fixtures.set("s2", pet2);
sessionsStore.set({
	...sessionsStore.getSnapshot(),
	ids: ["s1", "s2"],
	byId: {
		...sessionsStore.getSnapshot().byId,
		s2: { id: "s2", displayTitle: "第二个会话", running: false, blank: false, updatedAt: Date.now() }
	},
	current: "s2"
});

const follow = new exports_.PetFollow(ctx);
const direct = [];
const feed = (label, fn) => {
	fn();
	direct.push([label, follow.getState().mood]);
};

follow.start();
feed("direct idle", () => {});
feed("direct running", () => pet2.setRunning(true));
feed("direct turn/start", () => pet2.push({ type: "turn/start", seq: 101, time: Date.now(), data: { turn: 1 } }));
feed("direct tool/call", () => pet2.push({ type: "tool/call", seq: 102, time: Date.now(), data: { turn: 1, step: 1, callId: "d1", name: "write", arguments: "{}" } }));
feed("direct tool/result", () => pet2.push({ type: "tool/result", seq: 103, time: Date.now(), data: { turn: 1, step: 1, message: {} } }));
feed("direct approval/asked", () => pet2.push({ type: "approval/asked", seq: 104, time: Date.now(), data: { requestId: "r9" } }));
feed("direct approval/decided", () => pet2.push({ type: "approval/decided", seq: 105, time: Date.now(), data: { requestId: "r9", decision: "approve" } }));
feed("direct turn/end error", () => {
	pet2.push({ type: "turn/end", seq: 106, time: Date.now(), data: { turn: 1, reason: "error" } });
	pet2.setRunning(false);
});
feed("direct turn/start ok", () => {
	pet2.setRunning(true);
	pet2.push({ type: "turn/start", seq: 107, time: Date.now(), data: { turn: 2 } });
});
feed("direct turn/end success", () => {
	pet2.push({ type: "turn/end", seq: 108, time: Date.now(), data: { turn: 2, reason: "success" } });
	pet2.setRunning(false);
});
follow.stop();

console.log("\nfollow-store walk:");
for (const [label, m] of direct) console.log("  " + label.padEnd(26) + " -> " + m);
if (process.env.XW_DEBUG === "1") {
	console.error("DEBUG timeline:", JSON.stringify(steps.map(([l, m]) => [l, m])));
}
const directExpected = ["idle", "think", "think", "work", "think", "wait", "think", "oops", "think", "done"];
assert.deepStrictEqual(
	direct.map(([, m]) => m),
	directExpected,
	"follow-store mood mismatch\n  expected " + JSON.stringify(directExpected) + "\n  actual   " + JSON.stringify(direct.map(([, m]) => m))
);

console.log("\nOK: bundle materializes, registers, and derives every mood correctly.");
//#endregion
