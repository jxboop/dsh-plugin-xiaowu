/**
 * 小舞 · DSH 桌宠 — browser half (bundle id: dsh-plugin-xiaowu).
 *
 * A hand-drawn (SVG) bunny-eared desktop pet that lives in the bottom-right
 * corner of the DSH Web GUI. It reads the live agent state off the client
 * Session object layer and reacts:
 *
 *   idle    待机     breathing, blinking, ear twitches
 *   think   思考     swaying, "?" bubble
 *   work    干活     hammer + sparks, tick sound on every new tool call
 *   wait    等确认   hand raised, gentle chime when an approval is asked
 *   done    完成     jumps, hearts and sparkles, says 「做完啦……」
 *   oops    出错     drooping ears, sad tone
 *   sleep   睡       closes eyes when nothing has happened for a while
 *
 * The completion voice is synthesized at runtime by a small FM/formant engine
 * (see `voice` below): no sample, no recording, nothing downloaded.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-xiaowu",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOM = require("react-dom");
		const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

		/** Tiny JSX-free element helper (this bundle is hand-written, not built). */
		const h = React.createElement;

		const PLUGIN_ID = "dsh-plugin-xiaowu";
		const NS = "xiaowu";
		/**
		 * Build stamp. Bump it whenever this bundle changes, then reload the
		 * package: `window.__DSH_XIAOWU__.build` (or the one console line printed
		 * at apply time) tells you which revision the live page is running, with
		 * no need to trust any cache.
		 */
		const BUILD = "0.1.2";
		const STYLE_ID = PLUGIN_ID + ":style";
		const PREF_KEY = "dsh-plugin-xiaowu:audio";
		const COMPLETION_HOLD_MS = 5200;
		const SLEEP_AFTER_MS = 90000;
		const SESSION_PENDING_HINT_MS = 1500;

		const zh = {
			"pet.aria": "小舞，DSH 桌宠",
			"pet.name": "小舞",
			"audio.on": "声音：开",
			"audio.off": "声音：关",
			"audio.toggle": "切换桌宠声音",
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
			"detail.tool": "正在使用 {name}",
			"detail.thinking": "正在推理与撰写",
			"detail.idle": "空闲",
			"detail.done": "任务已完成",
			"detail.wait": "等待你的确认",
			"detail.oops": "上一轮出错了",
			"detail.cancelled": "这一轮被取消了",
			"detail.sleep": "很久没有新动静",
			"detail.nosession": "还没有打开会话",
			"popover.hint": "点小舞可以摸摸她，右上角可以关掉声音",
			"popover.pat": "呼哇～好舒服！",
			"popover.patDance": "嘻嘻，小舞跳给你看～"
		};

		const en = {
			"pet.aria": "Xiao Wu, the DSH desktop pet",
			"pet.name": "Xiao Wu",
			"audio.on": "Sound: on",
			"audio.off": "Sound: off",
			"audio.toggle": "Toggle pet sound",
			"state.idle": "Idle",
			"state.think": "Thinking",
			"state.work": "Working",
			"state.wait": "Waiting for you",
			"state.done": "All done",
			"state.oops": "Something broke",
			"state.sleep": "Sleeping",
			"say.idle": "I'm right here with you",
			"say.think": "Hmm, let me think…",
			"say.work": "Working on it!",
			"say.wait": "Just waiting for your nod",
			"say.done": "All done…",
			"say.oops": "Oops, that one failed",
			"say.sleep": "zzz…",
			"detail.tool": "Using {name}",
			"detail.thinking": "Reasoning and writing",
			"detail.idle": "Idle",
			"detail.done": "Task completed",
			"detail.wait": "Waiting for your approval",
			"detail.oops": "The last turn failed",
			"detail.cancelled": "That turn was cancelled",
			"detail.sleep": "Nothing new for a while",
			"detail.nosession": "No session open yet",
			"popover.hint": "Tap Xiao Wu for a pat; the top-right button mutes her",
			"popover.pat": "Wah, that feels nice!",
			"popover.patDance": "Hehe, watch me dance~"
		};

		const MOODS = ["idle", "think", "work", "wait", "done", "oops", "sleep"];

		//#region ── audio: the synthesized voice and the pet's little sounds ──

		/**
		 * A tiny FM/formant voice engine. Every sound here is generated from
		 * oscillators and gain envelopes at call time: the "做完啦……" line is a
		 * four-note phrase (G5 → A5 → G5 → D5) with a breathy consonant burst on
		 * each syllable, a soft pad an octave below, and a sparkle tail.
		 */
		const voice = (() => {
			let ctx = null;
			let master = null;
			let muted = readMuted();
			let lastTick = 0;

			function readMuted() {
				try {
					const raw = window.localStorage.getItem(PREF_KEY);
					if (raw === null) return false;
					return raw === "off";
				} catch {
					return false;
				}
			}

			function persist() {
				try {
					window.localStorage.setItem(PREF_KEY, muted ? "off" : "on");
				} catch {
					/* private mode: the preference just stays session-local */
				}
			}

			/** Build the AudioContext on demand; returns null where WebAudio is absent. */
			function graph() {
				if (muted) return null;
				if (ctx !== null && ctx.state === "closed") {
					ctx = null;
					master = null;
				}
				if (ctx === null) {
					const Ctor = window.AudioContext || window.webkitAudioContext;
					if (Ctor === undefined) return null;
					try {
						ctx = new Ctor();
					} catch {
						return null;
					}
					master = ctx.createGain();
					master.gain.value = 0.9;
					master.connect(ctx.destination);
				}
				if (ctx.state === "suspended") ctx.resume().catch(() => {});
				return ctx;
			}

			/** One Vowel: glide `from` → `to` Hz, with optional FM, breath, pan and glide-in. */
			function vowel(audio, spec) {
				const {
					at, dur, from, to = from, peak = 0.16, attack = 0.012, curve = 0.5,
					fm = 0, index = 0, breath = 0, pan = 0, vibrato = 0.32, ramp = 0
				} = spec;
				const out = audio.createGain();
				const panner = typeof audio.createStereoPanner === "function" ? audio.createStereoPanner() : null;
				if (panner !== null) {
					panner.pan.value = pan;
					out.connect(panner);
					panner.connect(master);
				} else {
					out.connect(master);
				}

				const env = audio.createGain();
				env.gain.value = 0.0001;
				env.connect(out);
				env.gain.setValueAtTime(0.0001, at);
				env.gain.linearRampToValueAtTime(peak, at + attack);
				env.gain.exponentialRampToValueAtTime(peak * 0.3, at + attack + (dur - attack) * curve);
				env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

				const tone = audio.createOscillator();
				tone.type = "triangle";
				if (ramp > 0) {
					tone.frequency.setValueAtTime(from * 0.75, at);
					tone.frequency.exponentialRampToValueAtTime(from, at + ramp);
				} else {
					tone.frequency.setValueAtTime(from, at);
				}
				if (to !== from) tone.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + dur * 0.95);

				const soft = audio.createOscillator();
				soft.type = "sine";
				soft.frequency.setValueAtTime(from * 2.002, at);
				if (to !== from) soft.frequency.exponentialRampToValueAtTime(Math.max(40, to * 2.002), at + dur * 0.95);
				const softGain = audio.createGain();
				softGain.gain.value = 0.34;

				const vibratoOsc = audio.createOscillator();
				vibratoOsc.type = "sine";
				vibratoOsc.frequency.value = 5.4;
				const vibratoGain = audio.createGain();
				vibratoGain.gain.value = from * (vibrato / 100);
				vibratoOsc.connect(vibratoGain);
				vibratoGain.connect(tone.frequency);
				vibratoGain.connect(soft.frequency);

				tone.connect(env);
				soft.connect(softGain);
				softGain.connect(env);

				let modOsc = null;
				if (fm > 0 && index > 0) {
					modOsc = audio.createOscillator();
					modOsc.type = "sine";
					modOsc.frequency.value = fm;
					const modGain = audio.createGain();
					modGain.gain.value = fm * index;
					modOsc.connect(modGain);
					modGain.connect(tone.frequency);
				}

				const sources = [tone, soft, vibratoOsc];
				if (modOsc !== null) sources.push(modOsc);
				for (const osc of sources) {
					osc.start(at);
					osc.stop(at + dur + 0.05);
				}

				if (breath > 0) {
					const frames = Math.max(1, Math.round(audio.sampleRate * 0.045));
					const buffer = audio.createBuffer(1, frames, audio.sampleRate);
					const data = buffer.getChannelData(0);
					for (let i = 0; i < frames; i += 1) {
						const t = i / frames;
						data[i] = (Math.random() * 2 - 1) * (1 - t) * (1 - t);
					}
					const src = audio.createBufferSource();
					src.buffer = buffer;
					const band = audio.createBiquadFilter();
					band.type = "bandpass";
					band.frequency.value = Math.max(700, from * 1.6);
					band.Q.value = 1.1;
					const ng = audio.createGain();
					ng.gain.value = breath;
					src.connect(band);
					band.connect(ng);
					ng.connect(panner !== null ? panner : master);
					src.start(at);
				}
			}

			/** One struck bell/bubble, used for the pet's non-verbal cues. */
			function bell(audio, spec) {
				const { at, freq, dur = 0.35, peak = 0.12, type = "sine", pan = 0, ratio = 2.01 } = spec;
				const out = audio.createGain();
				const panner = typeof audio.createStereoPanner === "function" ? audio.createStereoPanner() : null;
				if (panner !== null) {
					panner.pan.value = pan;
					out.connect(panner);
					panner.connect(master);
				} else {
					out.connect(master);
				}
				out.gain.setValueAtTime(0.0001, at);
				out.gain.linearRampToValueAtTime(peak, at + 0.008);
				out.gain.exponentialRampToValueAtTime(0.0001, at + dur);

				const a = audio.createOscillator();
				a.type = type;
				a.frequency.value = freq;
				const b = audio.createOscillator();
				b.type = "sine";
				b.frequency.value = freq * ratio;
				const bg = audio.createGain();
				bg.gain.value = 0.3;
				a.connect(out);
				b.connect(bg);
				bg.connect(out);
				a.start(at);
				a.stop(at + dur + 0.02);
				b.start(at);
				b.stop(at + dur + 0.02);
			}

			/** 「做完啦……」 — the signature line, sung rather than spoken. */
			function phrase() {
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.06;
				// 做  完  啦  ……   (a soft closing hum)
				const notes = [
					{ at: 0.0, dur: 0.24, from: 784, to: 812, peak: 0.19, fm: 1300, index: 0.85, breath: 0.05, pan: -0.22, ramp: 0.02 },
					{ at: 0.2, dur: 0.3, from: 880, to: 858, peak: 0.2, fm: 1460, index: 0.95, breath: 0.045, pan: 0.06, ramp: 0.025 },
					{ at: 0.47, dur: 0.3, from: 784, to: 768, peak: 0.17, fm: 1300, index: 0.75, breath: 0.04, pan: 0.24, ramp: 0.02 },
					{ at: 0.75, dur: 0.66, from: 587, to: 566, peak: 0.13, fm: 970, index: 0.6, breath: 0.028, pan: 0.0, ramp: 0.045 }
				];
				for (const note of notes) {
					vowel(audio, { ...note, at: t0 + note.at });
					// an octave-below pad gives the phrase a warm body
					vowel(audio, {
						at: t0 + note.at,
						dur: note.dur * 1.1,
						from: note.from / 2,
						to: note.to / 2,
						peak: note.peak * 0.3,
						fm: 0,
						index: 0,
						breath: 0,
						pan: -note.pan * 0.5
					});
				}
				// sparkle tail: G5 → C6 → E6, gentle and quick
				const tail = [[784, 0], [1046.5, 0.1], [1318.5, 0.2]];
				for (const [freq, offset] of tail) {
					bell(audio, { at: t0 + 1.32 + offset, freq, dur: 0.5, peak: 0.075, pan: offset * 1.2 - 0.1 });
				}
				return true;
			}

			/** A soft double thump — the bunny hop under every step. */
			function hop() {
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.01;
				bell(audio, { at: t0, freq: 170, dur: 0.13, peak: 0.075, type: "triangle" });
				bell(audio, { at: t0 + 0.1, freq: 214, dur: 0.15, peak: 0.05, type: "triangle", pan: 0.16 });
				return true;
			}

			/** A light tick for "a new tool call started". */
			function tick() {
				const now = Date.now();
				if (now - lastTick < 320) return false;
				lastTick = now;
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.005;
				bell(audio, { at: t0, freq: 1420, dur: 0.07, peak: 0.035, pan: -0.1 });
				bell(audio, { at: t0 + 0.015, freq: 2120, dur: 0.05, peak: 0.018, pan: 0.12 });
				return true;
			}

			/** Two rising notes: someone needs the human's nod. */
			function chime() {
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.02;
				bell(audio, { at: t0, freq: 659.25, dur: 0.42, peak: 0.1, type: "triangle" });
				bell(audio, { at: t0 + 0.13, freq: 987.77, dur: 0.5, peak: 0.085, type: "triangle", pan: 0.15 });
				return true;
			}

			/** A small sad minor third — the turn failed. */
			function oops() {
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.02;
				bell(audio, { at: t0, freq: 440, dur: 0.34, peak: 0.09, type: "triangle" });
				bell(audio, { at: t0 + 0.16, freq: 349.23, dur: 0.5, peak: 0.075, type: "triangle", pan: -0.12 });
				return true;
			}

			/** A bubbly pop for "you patted me". */
			function pop() {
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.005;
				bell(audio, { at: t0, freq: 523.25, dur: 0.12, peak: 0.09, type: "triangle" });
				bell(audio, { at: t0 + 0.06, freq: 783.99, dur: 0.18, peak: 0.07, type: "triangle", pan: 0.2 });
				return true;
			}

			/** Four sleepy notes drifting downward. */
			function lullaby() {
				const audio = graph();
				if (audio === null) return false;
				const t0 = audio.currentTime + 0.02;
				const notes = [587.33, 493.88, 440, 349.23];
				for (let i = 0; i < notes.length; i += 1) {
					vowel(audio, {
						at: t0 + i * 0.34,
						dur: 0.4,
						from: notes[i],
						to: notes[i] * 0.99,
						peak: 0.085,
						fm: 620,
						index: 0.4,
						breath: 0.02,
						pan: i % 2 === 0 ? -0.15 : 0.15,
						ramp: 0.05
					});
				}
				return true;
			}

			return {
				phrase,
				hop,
				tick,
				chime,
				oops,
				pop,
				lullaby,
				/** Warm the AudioContext up on the first user gesture. */
				unlock() {
					graph();
				},
				isMuted() {
					return muted;
				},
				setMuted(next) {
					muted = next === true;
					persist();
					if (!muted) graph();
					return muted;
				},
				toggleMuted() {
					return this.setMuted(!muted);
				}
			};
		})();

		//#endregion

		//#region ── the client-side follow store: agent state → pet mood ──

		const ERROR_REASONS = new Set(["error", "failed"]);
		const CANCEL_REASONS = new Set(["aborted", "cancelled", "canceled"]);
		const DONE_REASONS = new Set(["success", "completed", "complete", "end", "stop"]);
		const READ_TOOLS = new Set(["read", "read_image", "glob", "grep", "search", "list", "list_dir"]);
		const EDIT_TOOLS = new Set(["write", "edit", "str_replace", "str-replace-editor", "create", "apply_patch", "notebook_edit"]);

		/** Short human-facing label for a tool name (kept tiny on purpose). */
		function toolFace(name) {
			if (EDIT_TOOLS.has(name)) return "✍️ " + name;
			if (READ_TOOLS.has(name)) return "🔍 " + name;
			if (name === "pwsh" || name === "bash" || name === "terminal") return "💻 " + name;
			if (name === "web_search" || name === "web_fetch") return "🌐 " + name;
			if (name === "todo_write") return "📋 " + name;
			if (name === "subagent" || name === "subagent_fork") return "🐣 " + name;
			return "🔧 " + name;
		}

		/**
		 * Follows one DSH client session and publishes an immutable pet state.
		 * Subscriptions exist exactly while the pet is mounted; the whole store
		 * is fiber-owned through `ctx.effect`.
		 */
		class PetFollow {
			constructor(ctx) {
				this.ctx = ctx;
				this.state = {
					mood: "idle",
					detail: "",
					sessionId: undefined,
					title: "",
					running: false,
					busy: false,
					since: Date.now()
				};
				this.listeners = new Set();
				this.disposers = [];
				this.session = null;
				this.unsubSession = null;
				this.unsubEvents = null;
				this.timer = null;
				this.completion = null;
				this.awaitingFirst = false;
				this.turnActive = false;
				this.lastTurnSeq = -1;
				this.lastEventSeq = -1;
				this.lastToolName = null;
				this.lastToolSeq = -1;
				this.lastResultSeq = -1;
				this.approvalSeq = -1;
				this.decisionSeq = -1;
				this.errorSeq = -1;
				this.wasRunning = false;
				this.lastActivity = Date.now();
				this.sleeping = false;
				this.pendingSince = 0;
				this.currentSessionId = null;
				this.started = false;
			}

			getState() {
				return this.state;
			}

			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}

			start() {
				if (this.started) return;
				this.started = true;
				const sessions = this.ctx.sessions;
				if (sessions === undefined) {
					this.publish({ mood: "idle", detail: "" });
					return;
				}
				const list = sessions.list;
				const onList = () => this.attach();
				this.disposers.push(list.subscribe(onList));
				this.attach();
				this.timer = window.setInterval(() => this.tick(), 1000);
			}

			stop() {
				this.started = false;
				this.detach();
				for (const dispose of this.disposers.splice(0)) {
					try {
						dispose();
					} catch {
						/* already gone */
					}
				}
				if (this.timer !== null) {
					window.clearInterval(this.timer);
					this.timer = null;
				}
			}

			attach() {
				const sessions = this.ctx.sessions;
				const list = sessions.list.getSnapshot();
				const id = list.current;
				if (id === this.currentSessionId) return;
				this.detach();
				this.currentSessionId = id;
				if (id === undefined) {
					this.publish({
						mood: "sleep",
						detail: "",
						sessionId: undefined,
						title: "",
						running: false,
						busy: false
					});
					return;
				}
				const binding = sessions.binding(id);
				this.session = binding !== undefined ? binding.session : null;
				const summary = list.byId[id];
				this.baseTitle = summary !== undefined ? summary.displayTitle : String(id);
				if (this.session !== null) {
					this.unsubSession = this.session.subscribe(() => this.onSession());
				}
				if (binding !== undefined && binding.eventSource !== undefined) {
					this.unsubEvents = binding.eventSource.subscribe(() => this.onEvents());
				}
				this.onSession();
				this.onEvents();
			}

			detach() {
				if (this.unsubSession !== null) {
					try {
						this.unsubSession();
					} catch {
						/* ignore */
					}
					this.unsubSession = null;
				}
				if (this.unsubEvents !== null) {
					try {
						this.unsubEvents();
					} catch {
						/* ignore */
					}
					this.unsubEvents = null;
				}
				this.session = null;
				this.awaitingFirst = false;
				this.turnActive = false;
				this.lastTurnSeq = -1;
				this.lastEventSeq = -1;
				this.lastToolName = null;
				this.lastToolSeq = -1;
				this.lastResultSeq = -1;
				this.approvalSeq = -1;
				this.decisionSeq = -1;
				this.errorSeq = -1;
				this.wasRunning = false;
				this.completion = null;
				this.sleeping = false;
				this.currentSessionId = null;
			}

			onSession() {
				if (this.session === null) return;
				const snapshot = this.session.getSnapshot();
				const running = snapshot.running === true;
				this.awaitingFirst = snapshot.awaitingFirstTurn === true;
				const lastError = snapshot.lastAgentError;
				if (typeof lastError === "string" && lastError.length > 0) this.lastAgentError = lastError;
				if (running) {
					this.lastActivity = Date.now();
					this.sleeping = false;
				}
				if (this.wasRunning && !running) {
					// Order matters: fold the event log FIRST. A turn that already ended
					// in the log must not be read as "finished successfully" just
					// because the running flag flipped before the subscription ran.
					this.onEvents();
					const failed = this.lastTurnReason !== undefined && ERROR_REASONS.has(this.lastTurnReason);
					if (!failed) {
						this.completion = {
							mood: "done",
							until: Date.now() + COMPLETION_HOLD_MS
						};
						this.ctx.emit("xiaowu/pet", { kind: "completion" });
					}
				}
				this.wasRunning = running;
				this.render();
			}

			onEvents() {
				const binding = this.ctx.sessions.binding(this.currentSessionId);
				const source = binding !== undefined ? binding.eventSource : undefined;
				if (source === undefined) return;
				let entries;
				try {
					entries = source.getSnapshot().entries;
				} catch {
					return;
				}
				if (entries === undefined || entries.length === 0) return;
				let changed = false;
				// The window is contiguous, so a forward scan from the last seen seq is enough.
				for (const entry of entries) {
					if (entry === undefined || entry.type !== "event") continue;
					const event = entry.event;
					if (event === undefined || typeof event.seq !== "number") continue;
					if (event.seq <= this.lastEventSeq) continue;
					this.lastEventSeq = event.seq;
					if (this.consume(event)) changed = true;
				}
				if (changed) {
					this.lastActivity = Date.now();
					this.sleeping = false;
				}
				this.render();
			}

			/** Fold one durable event into the pet's follow state. */
			consume(event) {
				const data = event.data;
				switch (event.type) {
					case "turn/start":
						this.turnActive = true;
						this.awaitingFirst = false;
						// A new turn supersedes a not-yet-expired completion hold, so a
						// failed turn cannot keep the pet celebrating the previous one.
						this.completion = null;
						return true;
					case "turn/end": {
						this.turnActive = false;
						this.lastTurnSeq = event.seq;
						this.lastTurnReason = data !== undefined ? data.reason : undefined;
						if (this.lastTurnReason !== undefined && ERROR_REASONS.has(this.lastTurnReason)) this.completion = null;
						return true;
					}
					case "tool/call": {
						const name = data !== undefined && typeof data.name === "string" ? data.name : "";
						if (name.length > 0) {
							this.lastToolName = name;
							this.lastToolSeq = event.seq;
							return true;
						}
						return false;
					}
					case "tool/result": {
						// The newest tool is no longer in flight: the pet goes back to thinking
						// until the model asks for the next one.
						this.lastResultSeq = event.seq;
						return true;
					}
					case "approval/asked":
						this.approvalSeq = event.seq;
						this.pendingSince = Date.now();
						return true;
					case "approval/decided":
						this.decisionSeq = event.seq;
						this.pendingSince = 0;
						return true;
					case "assistant/attempt":
						this.errorSeq = event.seq;
						return true;
					default:
						return false;
				}
			}

			/** Derive the mood after a short quiet period, then publish when it moved. */
			render() {
				const next = this.derive();
				if (next === null) {
					this.schedule();
					return;
				}
				this.publish(next);
			}

			schedule() {
				if (this.pendingTimer !== undefined) return;
				this.pendingTimer = window.setTimeout(() => {
					this.pendingTimer = undefined;
					this.render();
				}, 180);
			}

			derive() {
				const running = this.session !== null && this.session.getSnapshot().running === true;
				const title = this.baseTitle !== undefined ? this.baseTitle : "";
				if (this.completion !== null && Date.now() < this.completion.until) {
					return { mood: "done", detail: "detail.done", running, busy: false, title, sessionId: this.currentSessionId };
				}
				if (this.completion !== null) this.completion = null;
				if (!running) {
					const failed = this.session !== null && this.session.getSnapshot().lastAgentError !== null;
					const reason = this.lastTurnReason;
					const turnFailed = reason !== undefined && ERROR_REASONS.has(reason);
					const turnCancelled = reason !== undefined && CANCEL_REASONS.has(reason);
					if (failed || turnFailed) {
						return { mood: "oops", detail: "detail.oops", running: false, busy: false, title, sessionId: this.currentSessionId };
					}
					if (turnCancelled) {
						return { mood: "idle", detail: "detail.cancelled", running: false, busy: false, title, sessionId: this.currentSessionId };
					}
					if (this.sleeping || Date.now() - this.lastActivity > SLEEP_AFTER_MS) {
						this.sleeping = true;
						return { mood: "sleep", detail: "detail.sleep", running: false, busy: false, title, sessionId: this.currentSessionId };
					}
					return { mood: "idle", detail: "detail.idle", running: false, busy: false, title, sessionId: this.currentSessionId };
				}
				// The agent is working. A newer approval question wins; otherwise the
				// newest tool call, then a bare step, means "thinking".
				if (this.approvalSeq > this.decisionSeq) {
					return { mood: "wait", detail: "detail.wait", running: true, busy: true, title, sessionId: this.currentSessionId };
				}
				const toolIsLatest =
					this.lastToolName !== null &&
					this.lastToolSeq > Math.max(this.lastTurnSeq, this.approvalSeq, this.errorSeq, this.lastResultSeq);
				if (toolIsLatest) {
					return {
						mood: "work",
						detail: "detail.tool",
						tool: toolFace(this.lastToolName),
						toolName: this.lastToolName,
						running: true,
						busy: true,
						title,
						sessionId: this.currentSessionId
					};
				}
				this.awaitingFirst = false;
				return { mood: "think", detail: "detail.thinking", running: true, busy: true, title, sessionId: this.currentSessionId };
			}

			/** One-second heartbeat: sleep timers, completion hold expiry, stalled prompts. */
			tick() {
				const now = Date.now();
				if (this.approvalSeq > this.decisionSeq && this.pendingSince > 0 && now - this.pendingSince > SESSION_PENDING_HINT_MS) {
					this.pendingSince = now * 2; // hint once per approval question
				}
				if (!(this.completion !== null && now < this.completion.until) && !this.sleeping && this.session !== null) {
					const running = this.session.getSnapshot().running === true;
					if (!running && now - this.lastActivity > SLEEP_AFTER_MS) this.sleeping = true;
				}
				this.render();
			}

			publish(patch) {
				const previous = this.state;
				const next = { ...previous, ...patch, since: Date.now() };
				if (
					previous.mood === next.mood &&
					previous.detail === next.detail &&
					previous.tool === next.tool &&
					previous.toolName === next.toolName &&
					previous.running === next.running &&
					previous.busy === next.busy &&
					previous.title === next.title &&
					previous.sessionId === next.sessionId
				) {
					return;
				}
				if (next.mood !== previous.mood) next.since = Date.now();
				else next.since = previous.since;
				this.state = next;
				for (const listener of [...this.listeners]) {
					try {
						listener();
					} catch (error) {
						console.error("[xiaowu] pet listener failed:", error);
					}
				}
			}
		}

		//#endregion

		//#region ── the pet's own stylesheet ──

		const CSS = `
.dsh-xw-root{--xw-a:#ff9dc4;--xw-b:#f4659b;--xw-c:#e0447c;--xw-ink:#5b2a3d;--xw-panel:rgba(255,255,255,.93);--xw-panel-ink:#6b2740;--xw-panel-line:rgba(224,68,124,.25);--xw-chip:rgba(255,255,255,.9);--xw-chip-ink:#8a3355;--xw-shadow:rgba(140,40,80,.28);
position:fixed;right:18px;bottom:14px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:inherit;--xw-s:1}
@media (prefers-color-scheme:dark){.dsh-xw-root{--xw-ink:#ffd9e8;--xw-panel:rgba(46,30,40,.92);--xw-panel-ink:#ffd9e8;--xw-panel-line:rgba(255,157,196,.3);--xw-chip:rgba(58,36,48,.92);--xw-chip-ink:#ffd0e2;--xw-shadow:rgba(0,0,0,.5)}}
.dsh-xw-stage{position:relative;pointer-events:auto;cursor:pointer;filter:drop-shadow(0 6px 10px var(--xw-shadow));transition:transform .18s ease}
.dsh-xw-stage:hover{transform:translateY(-3px) scale(1.03)}
.dsh-xw-svg{display:block;width:calc(112px * var(--xw-s));height:calc(112px * var(--xw-s));overflow:visible}
.dsh-xw-bubble{position:absolute;bottom:calc(100% - 16px);right:calc(100% - 40px);min-width:58px;padding:6px 10px;border-radius:12px;background:var(--xw-chip);color:var(--xw-chip-ink);font-size:12px;line-height:1.4;white-space:nowrap;box-shadow:0 4px 12px var(--xw-shadow);opacity:0;transform:translateY(6px) scale(.92);transition:opacity .22s ease,transform .22s ease;pointer-events:none}
.dsh-xw-bubble.is-on{opacity:1;transform:translateY(0) scale(1)}
.dsh-xw-after{display:flex;gap:6px;align-items:center;pointer-events:auto}
.dsh-xw-chip{padding:3px 9px;border-radius:999px;background:var(--xw-chip);color:var(--xw-chip-ink);font-size:11px;line-height:1.5;box-shadow:0 3px 10px var(--xw-shadow);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.dsh-xw-chip.is-tool{font-variant-numeric:tabular-nums}
.dsh-xw-btn{appearance:none;border:1px solid var(--xw-panel-line);background:var(--xw-chip);color:var(--xw-chip-ink);border-radius:999px;font-size:11px;padding:3px 8px;cursor:pointer;line-height:1.4}
.dsh-xw-btn:hover{background:var(--xw-panel)}
.dsh-xw-pop{pointer-events:auto;position:absolute;right:0;bottom:calc(100% + 10px);width:216px;padding:10px 12px;border-radius:14px;background:var(--xw-panel);color:var(--xw-panel-ink);font-size:12px;line-height:1.6;box-shadow:0 10px 26px var(--xw-shadow);border:1px solid var(--xw-panel-line);opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}
.dsh-xw-pop.is-on{opacity:1;transform:translateY(0);pointer-events:auto}
.dsh-xw-pop b{display:block;font-size:13px;margin-bottom:4px;color:var(--xw-c)}
.dsh-xw-pop .dsh-xw-k{opacity:.72}
/* ── the character ───────────────────────────────────────────────────── */
.dsh-xw-tail{transform-box:fill-box;transform-origin:0% 100%}
.dsh-xw-ears{transform-box:fill-box;transform-origin:50% 100%}
.dsh-xw-ear-l{transform-box:fill-box;transform-origin:50% 94%}
.dsh-xw-ear-r{transform-box:fill-box;transform-origin:50% 94%}
.dsh-xw-head{transform-box:fill-box;transform-origin:50% 72%}
.dsh-xw-torso{transform-box:fill-box;transform-origin:50% 100%}
.dsh-xw-body{transform-box:fill-box;transform-origin:50% 100%}
.dsh-xw-arm{transform-box:fill-box;transform-origin:50% 8%}
.dsh-xw-blush{opacity:.72}
.dsh-xw-pupil{transition:transform .18s ease-out}
.dsh-xw-iris{transition:transform .18s ease-out}
.dsh-xw-eyelid,.dsh-xw-happy-eye{opacity:0}
.dsh-xw-sleep-eye{opacity:0}
.dsh-xw-zzz{opacity:0}
.dsh-xw-hammer,.dsh-xw-hearts,.dsh-xw-qmark,.dsh-xw-bang,.dsh-xw-sweat,.dsh-xw-tear,.dsh-xw-spark,.dsh-xw-hopmark,.dsh-xw-note,.dsh-xw-halo{opacity:0}
.dsh-xw-aura{transform-box:fill-box;transform-origin:50% 50%;opacity:.7}
.dsh-xw-hammer{transform-box:fill-box;transform-origin:85% 90%}
.dsh-xw-spark,.dsh-xw-hearts,.dsh-xw-note,.dsh-xw-hopmark{transform-box:fill-box;transform-origin:50% 50%}
/* ── idle: breathing, blinking, ear twitches ─────────────────────────── */
@keyframes xw-breathe{0%,100%{transform:translateY(0) scaleY(1)}45%{transform:translateY(2.4px) scaleY(.978)}70%{transform:translateY(-1px) scaleY(1.008)}}
@keyframes xw-sway{0%,100%{transform:rotate(-2.6deg) translateY(0)}50%{transform:rotate(2.6deg) translateY(-2px)}}
@keyframes xw-headSway{0%,100%{transform:rotate(-2.2deg)}50%{transform:rotate(2.2deg)}}
@keyframes xw-earSway{0%,100%{transform:rotate(-4.5deg)}50%{transform:rotate(4.5deg)}}
@keyframes xw-earL{0%,100%{transform:rotate(-9deg)}42%{transform:rotate(-2.5deg)}58%{transform:rotate(-3.5deg)}}
@keyframes xw-earR{0%,100%{transform:rotate(9deg)}42%{transform:rotate(3deg)}58%{transform:rotate(4deg)}}
@keyframes xw-earFlick{0%,88%,100%{transform:rotate(0)}91%{transform:rotate(-9deg)}94%{transform:rotate(6deg)}97%{transform:rotate(-3deg)}}
@keyframes xw-tail{0%,100%{transform:rotate(0)}50%{transform:rotate(9deg)}}
@keyframes xw-blink{0%,90%,100%{transform:scaleY(1)}93%,96%{transform:scaleY(.06)}}
@keyframes xw-aura{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:.8;transform:scale(1.045)}}
.dsh-xw-root[data-mood="idle"] .dsh-xw-body{animation:xw-breathe 3.4s ease-in-out infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-torso{animation:xw-sway 5.2s ease-in-out infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-head{animation:xw-headSway 5.2s ease-in-out infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-ears{animation:xw-earSway 6.2s ease-in-out infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-ear-l{animation:xw-earL 5.6s ease-in-out infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-ear-r{animation:xw-earR 5.6s ease-in-out infinite .4s}
.dsh-xw-root[data-mood="idle"] .dsh-xw-tail{animation:xw-tail 3.8s ease-in-out infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-eyewrap{animation:xw-blink 5.6s linear infinite}
.dsh-xw-root[data-mood="idle"] .dsh-xw-aura{animation:xw-aura 4.6s ease-in-out infinite}
/* ── think: gentle sway, "?" bubble ──────────────────────────────────── */
@keyframes xw-think{0%,100%{transform:rotate(-3.4deg)}50%{transform:rotate(3.4deg)}}
@keyframes xw-floatUp{0%{opacity:0;transform:translateY(6px) scale(.7)}30%{opacity:1}100%{opacity:0;transform:translateY(-16px) scale(1.05)}}
.dsh-xw-root[data-mood="think"] .dsh-xw-body{animation:xw-breathe 3s ease-in-out infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-torso{animation:xw-think 3.6s ease-in-out infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-head{animation:xw-headSway 4s ease-in-out infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-ear-l{animation:xw-earL 3.2s ease-in-out infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-ear-r{animation:xw-earR 3.2s ease-in-out infinite .3s}
.dsh-xw-root[data-mood="think"] .dsh-xw-tail{animation:xw-tail 2.6s ease-in-out infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-eyewrap{animation:xw-blink 7s linear infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-qmark{animation:xw-floatUp 2.4s ease-in-out infinite}
.dsh-xw-root[data-mood="think"] .dsh-xw-arm-front{animation:xw-think 3.6s ease-in-out infinite reverse}
/* ── work: hammering, sparks ─────────────────────────────────────────── */
@keyframes xw-hammer{0%{transform:rotate(-16deg)}14%{transform:rotate(30deg)}28%{transform:rotate(-16deg)}42%{transform:rotate(30deg)}56%{transform:rotate(-16deg)}70%{transform:rotate(30deg)}100%{transform:rotate(-16deg)}}
@keyframes xw-work{0%,100%{transform:translateY(0) rotate(-1.6deg)}50%{transform:translateY(-2.6px) rotate(1.6deg)}}
@keyframes xw-sparkPop{0%,62%{opacity:0;transform:scale(.4)}68%{opacity:1;transform:scale(1.1)}84%{opacity:.9;transform:scale(.9) translateY(-5px)}100%{opacity:0;transform:scale(.5) translateY(-9px)}}
.dsh-xw-root[data-mood="work"] .dsh-xw-body{animation:xw-work 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-torso{animation:xw-work 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-head{animation:xw-think 1.1s ease-in-out infinite reverse}
.dsh-xw-root[data-mood="work"] .dsh-xw-ear-l{animation:xw-earL 1.6s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-ear-r{animation:xw-earR 1.6s ease-in-out infinite .2s}
.dsh-xw-root[data-mood="work"] .dsh-xw-tail{animation:xw-tail 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-eyewrap{animation:xw-blink 4s linear infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-hammer{opacity:1;animation:xw-hammer 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-arm-front{animation:xw-hammer 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-arm-back{opacity:.25}
.dsh-xw-root[data-mood="work"] .dsh-xw-spark{animation:xw-sparkPop 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="work"] .dsh-xw-spark.s2{animation-delay:.24s}
.dsh-xw-root[data-mood="work"] .dsh-xw-spark.s3{animation-delay:.48s}
.dsh-xw-root[data-mood="work"] .dsh-xw-sweat{opacity:.9;animation:xw-floatUp 2.4s ease-in-out infinite .6s}
/* ── wait: hand raised, glowing ring, "!" ───────────────────────────── */
@keyframes xw-wait{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes xw-ringPulse{0%{opacity:.85;transform:scale(.7)}100%{opacity:0;transform:scale(1.5)}}
@keyframes xw-bangBob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.08)}}
.dsh-xw-root[data-mood="wait"] .dsh-xw-body{animation:xw-breathe 2.6s ease-in-out infinite}
.dsh-xw-root[data-mood="wait"] .dsh-xw-torso{animation:xw-wait 1.6s ease-in-out infinite}
.dsh-xw-root[data-mood="wait"] .dsh-xw-head{animation:xw-think 2.4s ease-in-out infinite reverse}
.dsh-xw-root[data-mood="wait"] .dsh-xw-ear-l{animation:xw-earL 2.2s ease-in-out infinite}
.dsh-xw-root[data-mood="wait"] .dsh-xw-ear-r{animation:xw-earR 2.2s ease-in-out infinite .25s}
.dsh-xw-root[data-mood="wait"] .dsh-xw-tail{animation:xw-tail 1.8s ease-in-out infinite}
.dsh-xw-root[data-mood="wait"] .dsh-xw-arm-front{transform:rotate(-24deg);opacity:1}
.dsh-xw-root[data-mood="wait"] .dsh-xw-bang{opacity:1;animation:xw-bangBob 1.1s ease-in-out infinite}
.dsh-xw-root[data-mood="wait"] .dsh-xw-halo{opacity:.85;animation:xw-ringPulse 1.9s ease-out infinite}
.dsh-xw-root[data-mood="wait"] .dsh-xw-pupil,.dsh-xw-root[data-mood="wait"] .dsh-xw-iris{transform:translateY(-1px)}
/* ── done: jump, hearts, sparkle burst ──────────────────────────────── */
@keyframes xw-jump{0%{transform:translateY(0) scaleY(.92)}10%{transform:translateY(0) scaleY(1.04)}26%{transform:translateY(-9px) scaleY(1.03)}44%{transform:translateY(0) scaleY(.95)}58%{transform:translateY(-4.5px) scaleY(1.01)}72%{transform:translateY(0) scaleY(.97)}100%{transform:translateY(0) scaleY(1)}}
@keyframes xw-heartUp{0%{opacity:0;transform:translateY(2px) scale(.5)}22%{opacity:1;transform:translateY(-4px) scale(1.05)}100%{opacity:0;transform:translateY(-26px) scale(.85)}}
@keyframes xw-spin{0%,100%{transform:rotate(-3deg) scale(1)}50%{transform:rotate(3deg) scale(1.03)}}
@keyframes xw-happyEye{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.9)}}
.dsh-xw-root[data-mood="done"] .dsh-xw-body{animation:xw-jump 1.02s cubic-bezier(.3,1.4,.5,1) infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-torso{animation:xw-spin 1.02s ease-in-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-head{animation:xw-think 1.02s ease-in-out infinite reverse}
.dsh-xw-root[data-mood="done"] .dsh-xw-ear-l{animation:xw-earL 1.02s ease-in-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-ear-r{animation:xw-earR 1.02s ease-in-out infinite .18s}
.dsh-xw-root[data-mood="done"] .dsh-xw-tail{animation:xw-tail .7s ease-in-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-eyewrap,.dsh-xw-root[data-mood="done"] .dsh-xw-normal-faces{opacity:0}
.dsh-xw-root[data-mood="done"] .dsh-xw-happy-eye{opacity:1;animation:xw-happyEye 1.02s ease-in-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-blush{opacity:.95}
.dsh-xw-root[data-mood="done"] .dsh-xw-hearts{animation:xw-heartUp 1.5s ease-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-hearts.h2{animation-delay:.3s}
.dsh-xw-root[data-mood="done"] .dsh-xw-hearts.h3{animation-delay:.62s}
.dsh-xw-root[data-mood="done"] .dsh-xw-spark{animation:xw-sparkPop 1.02s ease-in-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-spark.s2{animation-delay:.2s}
.dsh-xw-root[data-mood="done"] .dsh-xw-spark.s3{animation-delay:.4s}
.dsh-xw-root[data-mood="done"] .dsh-xw-hopmark{opacity:.9;animation:xw-heartUp 1.1s ease-out infinite .12s}
.dsh-xw-root[data-mood="done"] .dsh-xw-note{animation:xw-heartUp 1.7s ease-out infinite}
.dsh-xw-root[data-mood="done"] .dsh-xw-note.n2{animation-delay:.4s}
/* ── oops: drooping ears, a tear ────────────────────────────────────── */
@keyframes xw-slump{0%,100%{transform:translateY(1.5px) rotate(-1deg)}50%{transform:translateY(0) rotate(1deg)}}
@keyframes xw-tearDrop{0%{opacity:0;transform:translateY(-2px)}25%{opacity:.95}100%{opacity:0;transform:translateY(14px)}}
@keyframes xw-shake{0%,100%{transform:rotate(0)}25%{transform:rotate(-3deg)}75%{transform:rotate(3deg)}}
.dsh-xw-root[data-mood="oops"] .dsh-xw-body{animation:xw-slump 2.6s ease-in-out infinite}
.dsh-xw-root[data-mood="oops"] .dsh-xw-torso{animation:xw-shake 3.4s ease-in-out infinite}
.dsh-xw-root[data-mood="oops"] .dsh-xw-head{transform:rotate(-4deg)}
.dsh-xw-root[data-mood="oops"] .dsh-xw-ear-l{animation:xw-earL 3.4s ease-in-out infinite;transform:rotate(-20deg)}
.dsh-xw-root[data-mood="oops"] .dsh-xw-ear-r{animation:xw-earR 3.4s ease-in-out infinite;transform:rotate(20deg)}
.dsh-xw-root[data-mood="oops"] .dsh-xw-tail{animation:xw-tail 4.4s ease-in-out infinite;transform:rotate(-10deg)}
.dsh-xw-root[data-mood="oops"] .dsh-xw-eyewrap{opacity:.55}
.dsh-xw-root[data-mood="oops"] .dsh-xw-sweat{opacity:.85;animation:xw-tearDrop 2.2s ease-in infinite}
.dsh-xw-root[data-mood="oops"] .dsh-xw-tear{opacity:.9;animation:xw-tearDrop 2.2s ease-in infinite .5s}
/* ── sleep: closed eyes, zzz ────────────────────────────────────────── */
@keyframes xw-sleepBreathe{0%,100%{transform:translateY(1px) scaleY(.97) rotate(-1.5deg)}50%{transform:translateY(2.6px) scaleY(.955) rotate(1.5deg)}}
@keyframes xw-zzz{0%{opacity:0;transform:translate(0,0) scale(.6)}25%{opacity:.95}100%{opacity:0;transform:translate(10px,-30px) scale(1.1)}}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-body{animation:xw-sleepBreathe 4.6s ease-in-out infinite}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-torso{animation:xw-sleepBreathe 4.6s ease-in-out infinite}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-head{animation:xw-headSway 6.6s ease-in-out infinite;transform:rotate(-3deg)}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-ear-l{transform:rotate(-16deg)}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-ear-r{transform:rotate(16deg)}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-tail{animation:xw-tail 6.6s ease-in-out infinite}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-eyewrap{opacity:0}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-sleep-eye{opacity:1}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-zzz{animation:xw-zzz 3.4s ease-out infinite}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-zzz.z2{animation-delay:1.1s}
.dsh-xw-root[data-mood="sleep"] .dsh-xw-zzz.z3{animation-delay:2.2s}
/* ── poked: a quick happy hop ───────────────────────────────────────── */
@keyframes xw-poke{0%{transform:translateY(0) scale(1)}35%{transform:translateY(-10px) scale(1.06)}70%{transform:translateY(0) scale(.97)}100%{transform:translateY(0) scale(1)}}
.dsh-xw-root.is-poked .dsh-xw-body{animation:xw-poke .6s ease-out}
.dsh-xw-root.is-poked .dsh-xw-stage{animation:xw-shake .6s ease-out}
.dsh-xw-poke{color:var(--xw-c);font-size:11px;opacity:0;transition:opacity .2s ease}
.dsh-xw-poke.is-on{opacity:1}
@media (prefers-reduced-motion:reduce){.dsh-xw-root *{animation-duration:.001s!important;animation-iteration-count:1!important}.dsh-xw-stage:hover{transform:none}}
`;

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.pluginCss = PLUGIN_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		//#endregion

		//#region ── the character: an original bunny-girl drawn as plain SVG ──

		// Palette tokens double as the gradient stops, so the whole character can
		// be re-tinted from one place.
		const C = {
			hairA: "#ffc6de",
			hairB: "#f97cae",
			hairC: "#e0518f",
			hairD: "#a83570",
			skinA: "#fff2e8",
			skinB: "#ffdcc9",
			line: "#d1638f",
			eyeA: "#6f3fb0",
			eyeB: "#e35f9d",
			dressA: "#fffafc",
			dressB: "#ffd9e9",
			dressC: "#f483b2",
			ribbon: "#ff85b6",
			light: "#fff3cf"
		};

		function Defs() {
			return h(
				"defs",
				null,
				h(
					"linearGradient",
					{ id: "xw-hair", x1: "0.15", y1: "0", x2: "0.6", y2: "1" },
					h("stop", { offset: "0", stopColor: C.hairB }),
					h("stop", { offset: "0.5", stopColor: C.hairD }),
					h("stop", { offset: "1", stopColor: C.hairA })
				),
				h(
					"linearGradient",
					{ id: "xw-fringe", x1: "0", y1: "0", x2: "0.4", y2: "1" },
					h("stop", { offset: "0", stopColor: C.hairA }),
					h("stop", { offset: "1", stopColor: C.hairB })
				),
				h(
					"linearGradient",
					{ id: "xw-dress", x1: "0.2", y1: "0", x2: "0.7", y2: "1" },
					h("stop", { offset: "0", stopColor: C.dressA }),
					h("stop", { offset: "1", stopColor: C.dressB })
				),
				h(
					"linearGradient",
					{ id: "xw-skin", x1: "0.2", y1: "0", x2: "0.6", y2: "1" },
					h("stop", { offset: "0", stopColor: C.skinA }),
					h("stop", { offset: "1", stopColor: C.skinB })
				),
				h(
					"radialGradient",
					{ id: "xw-iris", cx: "0.35", cy: "0.3", r: "0.8" },
					h("stop", { offset: "0", stopColor: "#f9c6f2" }),
					h("stop", { offset: "0.42", stopColor: C.eyeB }),
					h("stop", { offset: "1", stopColor: C.eyeA })
				),
				h(
					"radialGradient",
					{ id: "xw-aura", cx: "0.5", cy: "0.5", r: "0.5" },
					h("stop", { offset: "0", stopColor: C.ribbon, stopOpacity: "0.42" }),
					h("stop", { offset: "0.7", stopColor: C.eyeA, stopOpacity: "0.2" }),
					h("stop", { offset: "1", stopColor: C.eyeA, stopOpacity: "0" })
				)
			);
		}

		/** One long bunny ear; the two mirror each other and differ only by class. */
		function Ear({ className, flip }) {
			const path = "M29.6 42.2C27.2 31 27.2 20 30.8 10.6";
			return h(
				"g",
				{ className, transform: flip ? "translate(83 0) scale(-1 1)" : undefined },
				h("path", { d: path, fill: "none", stroke: C.hairD, strokeWidth: "7.6", strokeLinecap: "round" }),
				h("path", { d: path, fill: "none", stroke: "url(#xw-hair)", strokeWidth: "5.6", strokeLinecap: "round" }),
				h("path", { d: "M29.4 36.4C28 28.6 28.4 21 31.2 15.2", fill: "none", stroke: C.ribbon, strokeWidth: "2", strokeLinecap: "round", opacity: "0.66" })
			);
		}

		function Character() {
			return h(
				"svg",
				{
					className: "dsh-xw-svg",
					viewBox: "7 -2 74 114",
					role: "img",
					"aria-hidden": "true",
					style: { overflow: "visible" }
				},
				h(Defs, null),
				h("ellipse", { cx: "41.5", cy: "105", rx: "15", ry: "3.2", fill: C.hairD, opacity: "0.15" }),
				h("ellipse", { className: "dsh-xw-aura", cx: "41.5", cy: "60", rx: "38", ry: "46", fill: "url(#xw-aura)" }),
				h(
					"g",
					{ className: "dsh-xw-body" },
					// The long plait flows behind everything, tied near its tip.
					h(
						"g",
						{ className: "dsh-xw-tail" },
						h("path", { d: "M53 32c8.4 10 12.4 22.6 11.6 37-0.6 11-4.4 19-9.6 24.4", fill: "none", stroke: C.hairD, strokeWidth: "8.2", strokeLinecap: "round" }),
						h("path", { d: "M53 32c8.4 10 12.4 22.6 11.6 37-0.6 11-4.4 19-9.6 24.4", fill: "none", stroke: "url(#xw-hair)", strokeWidth: "6.2", strokeLinecap: "round" }),
						h("ellipse", { cx: "60.6", cy: "86.6", rx: "4.6", ry: "2.6", fill: C.ribbon, transform: "rotate(-26 60.6 86.6)" }),
						h("path", { d: "M57.4 89.6c-2.6 2-4 4.6-4 8 3.2-.6 5.4-2.6 6.4-5.6z", fill: C.ribbon, opacity: "0.9" })
					),
					h(Ear, { className: "dsh-xw-ear-l", flip: false }),
					h(Ear, { className: "dsh-xw-ear-r", flip: true }),
					h(
						"g",
						{ className: "dsh-xw-legs" },
						h("path", { d: "M36.4 76.5c2.6 0 4 1.2 4 3.4v15.4c0 2.6-1.8 4.4-4.4 4.4s-4.4-1.8-4.4-4.4V79.9c0-2.2 1.6-3.4 4.8-3.4z", fill: "url(#xw-skin)" }),
						h("path", { d: "M46.6 76.5c3.2 0 4.8 1.2 4.8 3.4v15.4c0 2.6-1.8 4.4-4.4 4.4s-4.4-1.8-4.4-4.4V79.9c0-2.2 1.4-3.4 4-3.4z", fill: "url(#xw-skin)" }),
						h("ellipse", { cx: "36", cy: "99", rx: "4.6", ry: "2.6", fill: C.ribbon }),
						h("ellipse", { cx: "47", cy: "99", rx: "4.6", ry: "2.6", fill: C.ribbon })
					),
					h(
						"g",
						{ className: "dsh-xw-arm-back" },
						h("path", { d: "M55.4 54.6c3 0 4.6 1.6 4.8 4.4l1.2 15.6c.2 2.8-1.4 4.6-4 4.8-2.6.2-4.4-1.4-4.6-4.2L51.6 59c-.2-2.8 1.2-4.4 3.8-4.4z", fill: "url(#xw-skin)", transform: "rotate(-11 55 62)" })
					),
					h(
						"g",
						{ className: "dsh-xw-torso" },
						h("path", { d: "M41.5 55c6 0 10.4 2.8 12.6 8.2l4.2 10.6c1.2 3-.6 6.2-3.8 6.6l-13 1.6-13-1.6c-3.2-.4-5-3.6-3.8-6.6l4.2-10.6C30.9 57.8 35.5 55 41.5 55z", fill: "url(#xw-dress)" }),
						h("path", { d: "M28.6 80.8c3.8 2.6 8.3 4 12.9 4s9.1-1.4 12.9-4l1.7 4.2c-4.4 3-9.2 4.6-14.6 4.6s-10.2-1.6-14.6-4.6z", fill: C.dressC }),
						h("path", { d: "M31.4 76.4c6.4 2.6 13.8 2.6 20.2 0", fill: "none", stroke: C.dressC, strokeWidth: "1.1", opacity: "0.65" }),
						h("ellipse", { cx: "41.5", cy: "63.4", rx: "4.6", ry: "3.5", fill: C.ribbon }),
						h("path", { d: "M41.5 61.6l1.6 1.9-1.6 1.9-1.6-1.9z", fill: C.light, opacity: "0.95" }),
						h("path", { d: "M36.8 87.4c1.6 1.2 3.2 1.2 4.8 0 1.6 1.2 3.2 1.2 4.8 0", fill: "none", stroke: C.ribbon, strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.8" })
					),
					h(
						"g",
						{ className: "dsh-xw-arm-front" },
						h("path", { d: "M27.6 54.6c2.6 0 4 1.6 3.8 4.4l-1.2 15.2c-.2 2.8-2 4.4-4.6 4.2-2.6-.2-4.2-2-4-4.8L23 59c.2-2.8 1.8-4.4 4.6-4.4z", fill: "url(#xw-skin)", transform: "rotate(11 26 62)" }),
						h("circle", { cx: "24.6", cy: "75.4", r: "3.1", fill: "url(#xw-skin)", transform: "rotate(11 26 62)" }),
						h("ellipse", { cx: "24.4", cy: "79.2", rx: "3.6", ry: "1.5", fill: "#cfd6e4", transform: "rotate(11 26 62)" }),
						h(
							"g",
							{ className: "dsh-xw-hammer" },
							h("rect", { x: "15.4", y: "61.2", width: "3.8", height: "10.4", rx: "1.4", fill: "#dfa76a", transform: "rotate(26 17.3 66.4)" }),
							h("rect", { x: "14", y: "54.4", width: "11.6", height: "6.2", rx: "1.8", fill: "#a9b8c9", transform: "rotate(26 19.8 57.5)" })
						)
					),
					h(
						"g",
						{ className: "dsh-xw-head" },
						// hair mass behind the face, then the face, then the fringe
						h("path", { d: "M36.4 38.4C35.6 25.6 37.6 18.4 41.5 18.4s6.2 7.2 5.4 20z", fill: "url(#xw-hair)", opacity: "0.6" }),
						h("ellipse", { cx: "41.5", cy: "34.4", rx: "15.4", ry: "14.8", fill: "url(#xw-skin)" }),
						h("path", { d: "M25.2 32.6c-.6-10.4 6.4-17.2 16.3-17.2s16.8 6.8 16.6 16.8c-3.2-1.3-6.1-3.1-8.6-5.7-4 4.1-9.2 6.1-15.3 5.9-2.8-.1-5.6 0-9 .2z", fill: "url(#xw-fringe)" }),
						h("path", { d: "M28.8 23.6c3.8-4.2 9.6-6.4 15.4-6", fill: "none", stroke: "#fff", strokeWidth: "1.5", strokeLinecap: "round", opacity: "0.5" }),
						h(
							"g",
							{ className: "dsh-xw-normal-faces" },
							h(
								"g",
								{ className: "dsh-xw-eyewrap" },
								h("ellipse", { className: "dsh-xw-eye", cx: "35.6", cy: "35.6", rx: "3.6", ry: "4.1", fill: "#fff" }),
								h("ellipse", { className: "dsh-xw-eye", cx: "47.4", cy: "35.6", rx: "3.6", ry: "4.1", fill: "#fff" }),
								h("circle", { className: "dsh-xw-iris", cx: "35.8", cy: "36", r: "2.7", fill: "url(#xw-iris)" }),
								h("circle", { className: "dsh-xw-iris", cx: "47.6", cy: "36", r: "2.7", fill: "url(#xw-iris)" }),
								h("circle", { className: "dsh-xw-pupil", cx: "35.8", cy: "36.3", r: "1.3", fill: "#3b1533" }),
								h("circle", { className: "dsh-xw-pupil", cx: "47.6", cy: "36.3", r: "1.3", fill: "#3b1533" }),
								h("circle", { className: "dsh-xw-hilite", cx: "34.5", cy: "34.2", r: "1.1", fill: "#fff" }),
								h("circle", { className: "dsh-xw-hilite", cx: "46.3", cy: "34.2", r: "1.1", fill: "#fff" }),
								h("circle", { className: "dsh-xw-hilite", cx: "37", cy: "38", r: "0.55", fill: "#fff", opacity: "0.85" }),
								h("circle", { className: "dsh-xw-hilite", cx: "48.8", cy: "38", r: "0.55", fill: "#fff", opacity: "0.85" })
							),
							h("path", { className: "dsh-xw-brow", d: "M32.8 30.4c1.3-.9 2.8-1.1 4.3-.6", fill: "none", stroke: C.hairD, strokeWidth: "1", strokeLinecap: "round" }),
							h("path", { className: "dsh-xw-brow", d: "M46 29.8c1.5-.5 3-.3 4.3.6", fill: "none", stroke: C.hairD, strokeWidth: "1", strokeLinecap: "round" }),
							h("path", { className: "dsh-xw-mouth", d: "M39.4 42.6c1.3 1.5 3.4 1.5 4.7 0", fill: "none", stroke: C.line, strokeWidth: "1.1", strokeLinecap: "round" }),
							h("ellipse", { className: "dsh-xw-blush", cx: "30.6", cy: "40.4", rx: "3.4", ry: "2", fill: C.hairB, opacity: "0.45" }),
							h("ellipse", { className: "dsh-xw-blush", cx: "52.4", cy: "40.4", rx: "3.4", ry: "2", fill: C.hairB, opacity: "0.45" })
						),
						h(
							"g",
							{ className: "dsh-xw-happy-eye" },
							h("path", { d: "M32.2 36.8c1.5-2.6 4.8-2.6 6.3 0", fill: "none", stroke: "#4a1633", strokeWidth: "1.9", strokeLinecap: "round" }),
							h("path", { d: "M44.5 36.8c1.5-2.6 4.8-2.6 6.3 0", fill: "none", stroke: "#4a1633", strokeWidth: "1.9", strokeLinecap: "round" }),
							h("ellipse", { cx: "30.6", cy: "40.8", rx: "3.4", ry: "2", fill: C.hairB, opacity: "0.68" }),
							h("ellipse", { cx: "52.4", cy: "40.8", rx: "3.4", ry: "2", fill: C.hairB, opacity: "0.68" }),
							h("path", { d: "M39 42.4c1.6 2 4 2 5.6 0", fill: "none", stroke: C.line, strokeWidth: "1.2", strokeLinecap: "round" })
						),
						h(
							"g",
							{ className: "dsh-xw-sleep-eye" },
							h("path", { d: "M32.4 36.2c1.5 1.7 4.6 1.7 6.1 0", fill: "none", stroke: "#7a3a5c", strokeWidth: "1.4", strokeLinecap: "round" }),
							h("path", { d: "M44.7 36.2c1.5 1.7 4.6 1.7 6.1 0", fill: "none", stroke: "#7a3a5c", strokeWidth: "1.4", strokeLinecap: "round" }),
							h("ellipse", { cx: "30.8", cy: "40.6", rx: "3", ry: "1.8", fill: C.hairB, opacity: "0.42" }),
							h("ellipse", { cx: "52.2", cy: "40.6", rx: "3", ry: "1.8", fill: C.hairB, opacity: "0.42" }),
							h("ellipse", { cx: "41.5", cy: "42.8", rx: "1.4", ry: "1", fill: "#e2799f", opacity: "0.8" })
						),
						// face decorations: the white rabbit hairpin, the "!" bang, cues
						h("path", { className: "dsh-xw-bang", d: "M57.2 19.6c1.4 2.2 1.4 5.2 0 8", fill: "none", stroke: C.ribbon, strokeWidth: "2", strokeLinecap: "round" }),
						h(
							"g",
							{ className: "dsh-xw-pin" },
							h("ellipse", { cx: "51.8", cy: "21.6", rx: "1.5", ry: "2.9", fill: "#fff", opacity: "0.95", transform: "rotate(16 51.8 21.6)" }),
							h("ellipse", { cx: "55.2", cy: "21.2", rx: "1.5", ry: "2.9", fill: "#fff", opacity: "0.95", transform: "rotate(-16 55.2 21.2)" }),
							h("circle", { cx: "53.5", cy: "24.4", r: "1.5", fill: "#fff", opacity: "0.95" })
						),
						h(
							"g",
							{ className: "dsh-xw-qmark" },
							h("path", { d: "M62.4 13.4c0-2.5 1.9-4 4-4 2.3 0 4 1.4 4 3.6 0 3-3.8 3-3.8 5.3", fill: "none", stroke: C.ribbon, strokeWidth: "1.8", strokeLinecap: "round" }),
							h("circle", { cx: "66.6", cy: "22", r: "1.2", fill: C.ribbon })
						),
						h("circle", { className: "dsh-xw-halo", cx: "41.5", cy: "17", r: "8.6", fill: "none", stroke: C.ribbon, strokeWidth: "1.5", opacity: "0" }),
						h("ellipse", { className: "dsh-xw-sweat", cx: "60.4", cy: "27.6", rx: "1.8", ry: "2.5", fill: "#8fd3ff", opacity: "0" }),
						h("ellipse", { className: "dsh-xw-tear", cx: "32.6", cy: "40.6", rx: "1.5", ry: "2.1", fill: "#9fdcff", opacity: "0" })
					),
					// sparkles / hearts / notes / zzz
					h(
						"g",
						{ className: "dsh-xw-spark s1" },
						h("path", { d: "M61.6 54.6l1.6 4.8 4.8 1.6-4.8 1.6-1.6 4.8-1.6-4.8-4.8-1.6 4.8-1.6z", fill: C.light })
					),
					h(
						"g",
						{ className: "dsh-xw-spark s2" },
						h("path", { d: "M22.6 33.4l1.2 3.7 3.7 1.2-3.7 1.2-1.2 3.7-1.2-3.7-3.7-1.2 3.7-1.2z", fill: C.light })
					),
					h(
						"g",
						{ className: "dsh-xw-spark s3" },
						h("path", { d: "M63.6 86.4l1.1 3.3 3.3 1.1-3.3 1.1-1.1 3.3-1.1-3.3-3.3-1.1 3.3-1.1z", fill: C.light })
					),
					h(
						"g",
						{ className: "dsh-xw-hearts h1" },
						h("path", { d: "M64.6 39.6c-2-2-1.5-4.8.5-5.4 1.3-.4 2.4.5 2.8 1.4.4-.9 1.5-1.8 2.8-1.4 2 .6 2.5 3.4.5 5.4l-3.3 3.1z", fill: "#ff7fb5" })
					),
					h(
						"g",
						{ className: "dsh-xw-hearts h2" },
						h("path", { d: "M16.6 45.6c-1.7-1.7-1.2-3.9.4-4.4 1-.3 1.9.4 2.2 1.1.3-.7 1.2-1.4 2.2-1.1 1.7.5 2.1 2.7.4 4.4l-2.6 2.5z", fill: "#ff9dc4" })
					),
					h(
						"g",
						{ className: "dsh-xw-hearts h3" },
						h("path", { d: "M57.6 17.6c-1.5-1.5-1-3.4.4-3.9.9-.3 1.7.3 2 .9.3-.6 1-1.2 2-.9 1.5.4 1.9 2.3.4 3.9l-2.4 2.2z", fill: "#ffc6de" })
					),
					h(
						"g",
						{ className: "dsh-xw-note n1" },
						h("circle", { cx: "64.4", cy: "69.6", r: "2.4", fill: "#ffd166" }),
						h("rect", { x: "66", y: "58.6", width: "1.5", height: "11.2", fill: "#ffd166" }),
						h("path", { d: "M67.5 58.6c2.4.5 4 1.7 4.2 3.5-1.5-.7-2.9-.9-4.2-.6z", fill: "#ffd166" })
					),
					h(
						"g",
						{ className: "dsh-xw-note n2" },
						h("circle", { cx: "18.4", cy: "65.4", r: "2", fill: "#ffb3d1" }),
						h("rect", { x: "19.7", y: "56", width: "1.3", height: "9.6", fill: "#ffb3d1" }),
						h("path", { d: "M21 56c2 .5 3.4 1.4 3.6 2.9-1.3-.6-2.5-.8-3.6-.5z", fill: "#ffb3d1" })
					),
					h(
						"g",
						{ className: "dsh-xw-hopmark" },
						h("path", { d: "M34 23.6l1.4 2.8 3.2.4-2.3 2.1.5 3.1-2.8-1.5-2.8 1.5.5-3.1-2.3-2.1 3.2-.4z", fill: "#ffe066" })
					),
					h("text", { className: "dsh-xw-zzz z1", x: "57", y: "20", fontSize: "8", fill: C.hairD, fontWeight: "700" }, "z"),
					h("text", { className: "dsh-xw-zzz z2", x: "61.6", y: "14", fontSize: "10", fill: C.hairD, fontWeight: "700" }, "z"),
					h("text", { className: "dsh-xw-zzz z3", x: "66.4", y: "8", fontSize: "12", fill: C.hairD, fontWeight: "700" }, "Z")
				)
			);
		}

		//#endregion

		//#region ── the React surface ──

		/** Puppy-position tracker: the pupils follow the pointer (throttled to one rAF). */
		function usePointerFollow(rootRef) {
			useEffect(() => {
				let frame = 0;
				let latest = null;
				const apply = () => {
					frame = 0;
					const node = rootRef.current;
					if (node === null || latest === null) return;
					const svg = node.querySelector(".dsh-xw-svg");
					if (svg === null) return;
					const rect = svg.getBoundingClientRect();
					if (rect.width === 0) return;
					const scale = rect.width / 84;
					const dx = latest.x - (rect.left + rect.width / 2);
					const dy = latest.y - (rect.top + rect.height * 0.33);
					const len = Math.hypot(dx, dy) || 1;
					const amount = Math.min(1.5, len / 220);
					const ox = (dx / len) * amount;
					const oy = (dy / len) * amount;
					for (const node2 of node.querySelectorAll(".dsh-xw-pupil,.dsh-xw-iris,.dsh-xw-hilite")) {
						node2.setAttribute("transform", "translate(" + (ox * scale).toFixed(2) + " " + (oy * scale).toFixed(2) + ")");
					}
				};
				const onMove = (event) => {
					latest = { x: event.clientX, y: event.clientY };
					if (frame === 0) frame = window.requestAnimationFrame(apply);
				};
				window.addEventListener("pointermove", onMove, { passive: true });
				return () => {
					window.removeEventListener("pointermove", onMove);
					if (frame !== 0) window.cancelAnimationFrame(frame);
				};
			}, [rootRef]);
		}

		/** Audio lifecycle: unlock on the first gesture, fire the cue that fits the new mood. */
		function useMoodSounds(state) {
			const previous = useRef(state.mood);
			const previousTool = useRef(undefined);
			useEffect(() => {
				const unlock = () => voice.unlock();
				window.addEventListener("pointerdown", unlock, { once: true, capture: true });
				window.addEventListener("keydown", unlock, { once: true, capture: true });
				return () => {
					window.removeEventListener("pointerdown", unlock, { capture: true });
					window.removeEventListener("keydown", unlock, { capture: true });
				};
			}, []);
			useEffect(() => {
				const mood = state.mood;
				const changed = previous.current !== mood;
				previous.current = mood;
				if (!changed) {
					if (mood === "work" && state.toolName !== undefined && previousTool.current !== state.toolName) {
						previousTool.current = state.toolName;
						voice.tick();
					} else if (state.toolName !== undefined) {
						previousTool.current = state.toolName;
					}
					return;
				}
				if (mood === "work") {
					previousTool.current = state.toolName;
					voice.tick();
				} else if (mood === "wait") voice.chime();
				else if (mood === "oops") voice.oops();
				else if (mood === "done") voice.phrase();
				else if (mood === "sleep") voice.lullaby();
				else if (mood === "idle") voice.hop();
			}, [state.mood, state.toolName]);
		}

		function PetSurface(props) {
			const { follow, t } = props;
			const state = useSyncExternalStore(
				useCallback((listener) => follow.subscribe(listener), [follow]),
				useCallback(() => follow.getState(), [follow])
			);
			const [muted, setMutedState] = useState(() => voice.isMuted());
			const [open, setOpen] = useState(false);
			const [poked, setPoked] = useState(false);
			const [pokeNote, setPokeNote] = useState("");
			const rootRef = useRef(null);

			usePointerFollow(rootRef);
			useMoodSounds(state);

			useEffect(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);

			const mood = MOODS.includes(state.mood) ? state.mood : "idle";
			const detail = state.tool !== undefined && state.detail === "detail.tool" ? t("detail.tool", { name: state.tool }) : state.detail ? t(state.detail) : "";
			const say = t("say." + mood);
			const poke = useCallback(() => {
				const next = voice.toggleMuted();
				setMutedState(next);
				if (!next) voice.pop();
			}, []);
			const pat = useCallback(() => {
				voice.pop();
				setPoked(true);
				setPokeNote(t("popover.pat"));
				window.setTimeout(() => {
					setPoked(false);
					setPokeNote("");
				}, 900);
			}, [t]);
			const onStageClick = useCallback(() => {
				if (poked) return;
				pat();
			}, [pat, poked]);
			const onStageKey = useCallback(
				(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						pat();
					}
				},
				[pat]
			);

			return h(
				"div",
				{
					className: "dsh-xw-root" + (poked ? " is-poked" : ""),
					"data-mood": mood,
					ref: rootRef
				},
				h(
					"div",
					{ className: "dsh-xw-pop" + (open ? " is-on" : "") },
					h("b", null, t("pet.name") + " · " + t("state." + mood)),
					h("div", null, detail),
					state.title ? h("div", { className: "dsh-xw-k" }, state.title) : null,
					h("div", { className: "dsh-xw-k", style: { marginTop: "4px" } }, t("popover.hint"))
				),
				h(
					"button",
					{
						type: "button",
						className: "dsh-xw-stage",
						title: t("pet.aria"),
						"aria-label": t("pet.aria"),
						onClick: onStageClick,
						onKeyDown: onStageKey
					},
					h(
						"span",
						{ className: "dsh-xw-bubble" + (mood === "wait" || mood === "done" ? " is-on" : "") },
						say
					),
					h(Character, null)
				),
				h(
					"div",
					{ className: "dsh-xw-after" },
					h(
						"span",
						{ className: "dsh-xw-chip" + (state.tool !== undefined ? " is-tool" : ""), onClick: () => setOpen((value) => !value) },
						pokeNote.length > 0 ? pokeNote : state.tool !== undefined ? state.tool : t("state." + mood)
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-xw-btn",
							title: t("audio.toggle"),
							"aria-label": t("audio.toggle"),
							onClick: poke
						},
						muted ? "🔈" : "🔊"
					)
				)
			);
		}

		//#endregion

		//#region ── plugin body ──

		/** Required client services (Cordis fiber inject). */
		const inject = ["slots", "locale", "sessions"];

		/**
		 * Client plugin body: register the pet's copy, then hang one entry on the
		 * frame-wide overlay seat. The follow store's lifetime is the fiber's.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ensureStyle();
			// One line so the live page can be matched against the file on disk.
			try {
				window.__DSH_XIAOWU__ = { build: BUILD, plugin: PLUGIN_ID };
				console.info("[xiaowu] 桌宠已载入 build " + BUILD + " — window.__DSH_XIAOWU__ 可核对");
			} catch {
				/* a frozen window object must not break the pet */
			}
			ctx.effect(() => ctx.locale.register(NS, "zh", zh), "xiaowu: zh dictionary");
			ctx.effect(() => ctx.locale.register(NS, "en", en), "xiaowu: en dictionary");
			const follow = new PetFollow(ctx);
			ctx.effect(() => {
				follow.start();
				return () => follow.stop();
			}, "xiaowu: agent follow store");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "xiaowu-pet",
						order: 40
					},
					() => h(PetSurface, { follow, t })
				)
			);
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** The build stamp, readable by tooling and by the live page. */
		exports.build = BUILD;
		/** Lower-level surface for the mount harness: the follow store on its own. */
		exports.PetFollow = PetFollow;
		return module.exports;
	}
});
