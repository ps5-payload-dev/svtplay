/*
 * The application: a browsing shell and a player, and a navigation stack of
 * one between them.
 *
 * Everything the viewer can reach is a "frame" -- a view name plus a parameter
 * -- pushed onto a stack. Circle pops it. Frames remember which card was
 * focused, so backing out of a show puts the cursor back on that show. Listings
 * are re-fetched on the way back rather than kept as live DOM, which is what
 * the ten minute cache in svt.js is for.
 */
(function () {
	"use strict";

	var K = Input.KEY;

	var elCrumb   = document.getElementById("crumb");
	var elClock   = document.getElementById("clock");
	var elRail    = document.getElementById("rail");
	var elContent = document.getElementById("content");
	var elLoad    = document.getElementById("loadbar");
	var elHints   = document.getElementById("hints");
	var elHelp    = document.getElementById("help");
	var elToast   = document.getElementById("toast");

	var elPlayer  = document.getElementById("player");
	var video     = document.getElementById("video");
	var elOsd     = document.getElementById("osd");
	var elSpinner = document.getElementById("spinner");

	// Cards are cheap but not free, and A-Ö has letters with 200 shows in them.
	// Draw a screenful, then extend as the cursor approaches the end.
	var CHUNK = 40;
	var GROW_MARGIN = 12;

	var RAIL = [
		{id: "start",    name: "Start"},
		{id: "channels", name: "Kanaler"},
		{id: "programs", name: "Program A–Ö"},
		{id: "genres",   name: "Genrer"}
	];

	// Focus indices are counted within the listing only; the nav rail is
	// reachable by pressing Left but is never part of a saved position.
	var SCOPE = elContent;

	var stack = [];
	var token = 0;          // guards against a slow fetch overwriting a new view
	var entries = [];       // what the current listing is showing
	var drawn = 0;
	var gridEl = null;
	var mode = "browse";    // browse | player | help

	/* ------------------------------------------------------------ helpers */

	function esc(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function busy(on) {
		elLoad.className = on ? "on" : "";
	}

	var toastTimer = null;
	function toast(msg, isError) {
		elToast.textContent = msg;
		elToast.className = isError ? "error" : "";
		elToast.hidden = false;
		if (toastTimer) {
			clearTimeout(toastTimer);
		}
		toastTimer = setTimeout(function () {
			elToast.hidden = true;
		}, 3200);
	}

	function tickClock() {
		var d = new Date();
		var m = d.getMinutes();
		elClock.textContent = d.getHours() + ":" + (m < 10 ? "0" : "") + m;
	}

	function hints(pairs) {
		elHints.innerHTML = pairs.map(function (p) {
			return "<span><b>" + esc(p[0]) + "</b>" + esc(p[1]) + "</span>";
		}).join("");
	}

	function fmtTime(t) {
		if (!isFinite(t) || t < 0) {
			return "--:--";
		}
		t = Math.floor(t);
		var h = Math.floor(t / 3600);
		var m = Math.floor((t % 3600) / 60);
		var s = t % 60;
		function pad(n) { return (n < 10 ? "0" : "") + n; }
		return h ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
	}

	/* -------------------------------------------------------------- cards */

	function cardHtml(entry, i) {
		var thumb = entry.image
			? '<img src="' + esc(entry.image) + '" alt="" ' +
				'onerror="this.style.display=\'none\'">'
			: '<span class="glyph">' +
				(entry.type === "folder" ? "▤" : "▶") + "</span>";

		var badge = "";
		if (entry.live) {
			badge = '<span class="badge">Live</span>';
		} else if (entry.type === "folder") {
			badge = '<span class="badge folder">▤</span>';
		}

		return '<div class="card focusable" data-i="' + i + '">' +
			'<div class="thumb">' + thumb + badge + "</div>" +
			'<div class="meta">' +
			'<div class="name">' + esc(entry.name) + "</div>" +
			'<div class="desc">' + esc(entry.description || "") + "</div>" +
			"</div></div>";
	}

	function drawChunk() {
		if (!gridEl || drawn >= entries.length) {
			return;
		}
		var end = Math.min(entries.length, drawn + CHUNK);
		var html = "";
		for (var i = drawn; i < end; i++) {
			html += cardHtml(entries[i], i);
		}
		gridEl.insertAdjacentHTML("beforeend", html);
		drawn = end;
	}

	// Called on every focus change: keep at least GROW_MARGIN cards drawn ahead
	// of the cursor so running down a long list never hits a wall.
	Input.setFocusListener(function (el) {
		if (!gridEl || !el || !el.getAttribute) {
			return;
		}
		var i = parseInt(el.getAttribute("data-i"), 10);
		if (!isNaN(i) && i > drawn - GROW_MARGIN) {
			drawChunk();
		}
	});

	function notice(title, body, isError) {
		elContent.innerHTML = '<div class="notice' +
			(isError ? " error" : "") + '"><b>' + esc(title) + "</b>" +
			esc(body || "") + "</div>";
		gridEl = null;
		entries = [];
	}

	function listing(list, opts) {
		opts = opts || {};
		entries = list;
		drawn = 0;

		if (!list.length) {
			notice("Tomt", "Den här listan innehåller inget just nu.");
			Input.focusFirst();
			return;
		}

		elContent.innerHTML = (opts.head || "") +
			'<div class="grid" id="grid"></div>';
		gridEl = document.getElementById("grid");
		drawChunk();

		// A remembered position may sit past the first chunk.
		var want = opts.focus == null ? 0 : opts.focus;
		while (drawn <= want && drawn < list.length) {
			drawChunk();
		}
		Input.focusIndex(want, SCOPE);
	}

	/* --------------------------------------------------------------- rail */

	function drawRail(currentView) {
		elRail.innerHTML = RAIL.map(function (r) {
			return '<div class="rail-item focusable' +
				(r.id === currentView ? " current" : "") +
				'" data-rail="' + r.id + '">' + esc(r.name) + "</div>";
		}).join("");
	}

	/* -------------------------------------------------------------- views */

	function crumb(parts) {
		elCrumb.innerHTML = parts.map(function (p, i) {
			return (i ? '<i>›</i>' : "") +
				(i === parts.length - 1 ? "<b>" + esc(p) + "</b>" : esc(p));
		}).join("");
	}

	function frameOf(view, param, title) {
		return {view: view, param: param, title: title, focus: 0};
	}

	function go(frame) {
		var top = stack[stack.length - 1];
		if (top) {
			top.focus = Math.max(0, Input.indexOfFocused(SCOPE));
		}
		stack.push(frame);
		render(frame);
	}

	function back() {
		if (stack.length < 2) {
			// Nothing to pop: treat Circle as "take me to the menu".
			Input.focus(elRail.querySelector(".rail-item"));
			return;
		}
		stack.pop();
		render(stack[stack.length - 1]);
	}

	function rootView(frame) {
		// Which rail entry should light up for this frame.
		if (frame.view === "programs" || frame.view === "letters") {
			return "programs";
		}
		if (frame.view === "genre" || frame.view === "genres") {
			return "genres";
		}
		if (frame.view === "channels") {
			return "channels";
		}
		return "start";
	}

	function render(frame) {
		var my = ++token;
		drawRail(rootView(frame));
		gridEl = null;
		entries = [];
		busy(true);

		function fresh() {
			return my === token;
		}

		function fail(err) {
			if (!fresh()) { return; }
			busy(false);
			notice("Det gick inte att hämta listan",
				(err && err.message) || String(err), true);
			Input.focusFirst();
		}

		function done(list, head) {
			if (!fresh()) { return; }
			busy(false);
			listing(list, {head: head, focus: frame.focus});
		}

		if (frame.view === "start") {
			crumb(["Start"]);
			renderStart(my);
			return;
		}

		if (frame.view === "channels") {
			crumb(["Kanaler"]);
			SVT.channels().then(function (l) { done(l); }, fail);
			return;
		}

		if (frame.view === "letters") {
			crumb(["Program A–Ö"]);
			SVT.programLetters().then(function (letters) {
				if (!fresh()) { return; }
				busy(false);
				entries = [];
				drawn = 0;
				gridEl = null;
				elContent.innerHTML = '<div class="grid">' +
					letters.map(function (l) {
						return '<div class="chip focusable" data-letter="' +
							esc(l.letter) + '">' +
							'<span class="letter">' +
							esc(l.letter === "#" ? "0–9" : l.letter) +
							"</span>" +
							'<span class="count">' + l.count + "</span></div>";
					}).join("") + "</div>";
				Input.focusIndex(frame.focus, SCOPE);
			}, fail);
			return;
		}

		if (frame.view === "programs") {
			crumb(["Program A–Ö", frame.param === "#" ? "0–9" : frame.param]);
			SVT.programsByLetter(frame.param).then(function (l) {
				done(l);
			}, fail);
			return;
		}

		if (frame.view === "genres") {
			crumb(["Genrer"]);
			SVT.genres().then(function (l) { done(l); }, fail);
			return;
		}

		if (frame.view === "genre") {
			crumb(["Genrer", frame.title]);
			SVT.genre(frame.param).then(function (l) { done(l); }, fail);
			return;
		}

		if (frame.view === "show") {
			crumb(["Program", frame.title]);
			var path = frame.param.path;
			SVT.show(path, frame.param.group).then(function (res) {
				if (!fresh()) { return; }
				var h = res.head;
				var head = "";
				if (h && (h.name || h.description)) {
					head = '<div class="showhead">' +
						(h.image ? '<img src="' + esc(h.image) +
							'" alt="" onerror="this.style.display=\'none\'">' : "") +
						'<div class="txt"><h2>' + esc(h.name || frame.title) +
						"</h2><p>" + esc(h.description || "") + "</p></div></div>";
					crumb(["Program", h.name || frame.title]);
				}
				done(res.entries, head);
			}, fail);
			return;
		}

		fail(new Error("okänd vy: " + frame.view));
	}

	// The start page is four independent rows; draw the frame immediately and
	// let each row fill in on its own, so one slow listing does not hold up the
	// other three.
	function renderStart(my) {
		var rows = SVT.startRows();
		entries = [];
		drawn = 0;
		gridEl = null;

		elContent.innerHTML = rows.map(function (r) {
			return '<h2 class="section-title">' + esc(r.name) +
				"<span>" + esc(r.detail) + "</span></h2>" +
				'<div class="shelf" id="shelf-' + r.id + '"></div>';
		}).join("");

		var pending = rows.length;
		var want = stack[stack.length - 1].focus;
		var placed = false;

		function place() {
			if (placed) { return; }
			var cards = Input.all(SCOPE);
			if (!cards.length) { return; }
			placed = true;
			Input.focusIndex(Math.min(want, cards.length - 1), SCOPE);
		}

		rows.forEach(function (r) {
			SVT.selection(r.selectionId).then(function (list) {
				if (my !== token) { return; }
				var shelf = document.getElementById("shelf-" + r.id);
				if (!shelf) { return; }

				// Shelves resolve in whatever order they finish, so index each
				// card against the running total rather than its row.
				var base = entries.length;
				entries = entries.concat(list);
				drawn = entries.length;
				shelf.innerHTML = list.map(function (e, i) {
					return cardHtml(e, base + i);
				}).join("");

				// A cold start puts the cursor on the first card that appears;
				// a remembered position waits until every row is in.
				if (!want) { place(); }
			}, function (err) {
				if (my !== token) { return; }
				var shelf = document.getElementById("shelf-" + r.id);
				if (shelf) {
					shelf.innerHTML = '<div class="notice">' +
						esc((err && err.message) || "kunde inte hämtas") +
						"</div>";
				}
			}).then(function () {
				if (my !== token) { return; }
				pending--;
				if (pending === 0) {
					busy(false);
					place();
					if (!placed) { Input.focusFirst(); }
				}
			});
		});
	}

	/* ------------------------------------------------------------ opening */

	function openFocused() {
		var el = Input.current();
		if (!el) {
			return;
		}

		var rail = el.getAttribute("data-rail");
		if (rail) {
			stack = [frameOf(
				rail === "programs" ? "letters" : rail,
				null,
				null
			)];
			render(stack[0]);
			return;
		}

		var letter = el.getAttribute("data-letter");
		if (letter) {
			go(frameOf("programs", letter, letter));
			return;
		}

		var i = parseInt(el.getAttribute("data-i"), 10);
		if (isNaN(i) || !entries[i]) {
			return;
		}
		openEntry(entries[i]);
	}

	function openEntry(entry) {
		if (entry.type === "folder") {
			if (entry.id.indexOf("show:") === 0) {
				var rest = entry.id.substring(5);
				var bar = rest.indexOf("|");
				go(frameOf("show", bar < 0
					? {path: rest}
					: {path: rest.substring(0, bar), group: rest.substring(bar + 1)},
					entry.name));
			} else if (entry.id.indexOf("genre:") === 0) {
				go(frameOf("genre", entry.id.substring(6), entry.name));
			}
			return;
		}
		play(entry);
	}

	/* ------------------------------------------------------------- player */

	var hls = null;
	var currentEntry = null;
	var osdTimer = null;
	var seekAccum = 0;
	var seekTimer = null;

	function nativeHls() {
		return !!(video.canPlayType &&
			(video.canPlayType("application/vnd.apple.mpegurl") ||
			 video.canPlayType("application/x-mpegurl")));
	}

	function loadHlsJs() {
		if (window.Hls) {
			return Promise.resolve();
		}
		return new Promise(function (resolve, reject) {
			var s = document.createElement("script");
			s.src = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
			s.onload = resolve;
			s.onerror = function () {
				reject(new Error("hls.js kunde inte laddas"));
			};
			document.head.appendChild(s);
		});
	}

	function posKey(id) {
		return "svtplay.pos." + id;
	}

	function savePos() {
		if (!currentEntry || !isFinite(video.duration) || video.duration < 300) {
			return;
		}
		try {
			var t = video.currentTime;
			if (t > 60 && t < video.duration - 90) {
				localStorage.setItem(posKey(currentEntry.id), String(Math.floor(t)));
			} else {
				localStorage.removeItem(posKey(currentEntry.id));
			}
		} catch (e) { /* private mode, no storage: not worth a message */ }
	}

	function resumePos(id) {
		try {
			var v = parseInt(localStorage.getItem(posKey(id)), 10);
			return isNaN(v) ? 0 : v;
		} catch (e) {
			return 0;
		}
	}

	function play(entry) {
		currentEntry = entry;
		mode = "player";
		elPlayer.hidden = false;
		elSpinner.hidden = false;
		document.getElementById("osd-title").textContent = entry.name;
		document.getElementById("osd-desc").textContent = entry.description || "";
		document.getElementById("osd-state").textContent = "Laddar…";
		document.getElementById("osd-hints").innerHTML =
			"<span><b>✕</b>Paus</span>" +
			"<span><b>←→</b>10 s</span>" +
			"<span><b>L1/R1</b>1 min</span>" +
			"<span><b>L2/R2</b>5 min</span>" +
			"<span><b>□</b>Text</span>" +
			"<span><b>△</b>Ljudspår</span>" +
			"<span><b>○</b>Stäng</span>";
		showOsd(true);

		SVT.resolve(entry.id).then(function (url) {
			if (mode !== "player") {
				return;
			}
			return attach(url, entry);
		}, function (err) {
			stop();
			toast((err && err.message) || "Kunde inte starta uppspelningen", true);
		});
	}

	function attach(url, entry) {
		var resume = entry.live ? 0 : resumePos(entry.id);

		function started() {
			elSpinner.hidden = true;
			if (resume > 5) {
				try { video.currentTime = resume; } catch (e) { /* live */ }
				toast("Fortsätter från " + fmtTime(resume));
			}
			var p = video.play();
			if (p && p["catch"]) {
				p["catch"](function (err) {
					toast("Uppspelning blockerad: " + err.message, true);
				});
			}
		}

		if (nativeHls()) {
			// { once: true } is silently ignored by some older WebKit builds,
			// which would re-seek on every metadata event.
			var onMeta = function () {
				video.removeEventListener("loadedmetadata", onMeta);
				started();
			};
			video.src = url;
			video.addEventListener("loadedmetadata", onMeta);
			video.load();
			return;
		}

		return loadHlsJs().then(function () {
			if (!window.Hls || !window.Hls.isSupported()) {
				throw new Error("Ingen HLS-uppspelning i den här webbläsaren");
			}
			destroyHls();
			hls = new window.Hls({enableWorker: true});
			hls.on(window.Hls.Events.MANIFEST_PARSED, started);
			hls.on(window.Hls.Events.ERROR, function (evt, data) {
				if (data.fatal) {
					toast("Strömfel: " + data.details, true);
					stop();
				}
			});
			hls.loadSource(url);
			hls.attachMedia(video);
		})["catch"](function (err) {
			toast(err.message, true);
			stop();
		});
	}

	function destroyHls() {
		if (hls) {
			try { hls.destroy(); } catch (e) { /* already gone */ }
			hls = null;
		}
	}

	function stop() {
		savePos();
		try { video.pause(); } catch (e) { /* not started */ }
		destroyHls();
		video.removeAttribute("src");
		try { video.load(); } catch (e) { /* ignore */ }
		elPlayer.hidden = true;
		elSpinner.hidden = true;
		currentEntry = null;
		mode = "browse";
		browseHints();
	}

	function showOsd(sticky) {
		elOsd.className = "on";
		if (osdTimer) {
			clearTimeout(osdTimer);
			osdTimer = null;
		}
		if (!sticky) {
			osdTimer = setTimeout(function () {
				if (!video.paused) {
					elOsd.className = "";
				}
			}, 4000);
		}
	}

	function updateOsd() {
		var live = !isFinite(video.duration);
		var fill = document.getElementById("osd-fill");
		var head = document.getElementById("osd-head");
		var pct = live ? 100
			: (video.duration ? (video.currentTime / video.duration) * 100 : 0);
		fill.style.width = pct + "%";
		head.style.left = pct + "%";
		document.getElementById("osd-pos").textContent =
			live ? "LIVE" : fmtTime(video.currentTime);
		document.getElementById("osd-dur").textContent =
			live ? "" : fmtTime(video.duration);
	}

	function state(msg) {
		document.getElementById("osd-state").textContent = msg || "";
	}

	// Seek nudges arrive faster than the stream can respond, so add them up and
	// apply once the viewer stops pressing.
	function seek(delta) {
		if (!isFinite(video.duration)) {
			toast("Kan inte spola i en direktsändning");
			return;
		}
		seekAccum += delta;
		var target = Math.max(0,
			Math.min(video.duration - 1, video.currentTime + seekAccum));
		state((seekAccum > 0 ? "▶▶ +" : "◀◀ ") + fmtTime(Math.abs(seekAccum)) +
			"  →  " + fmtTime(target));
		showOsd(true);

		if (seekTimer) {
			clearTimeout(seekTimer);
		}
		seekTimer = setTimeout(function () {
			video.currentTime = target;
			seekAccum = 0;
			state("");
			showOsd(false);
		}, 350);
	}

	function cycleTextTracks() {
		var tracks = video.textTracks;
		if (!tracks || !tracks.length) {
			toast("Inga textspår i den här strömmen");
			return;
		}
		var active = -1;
		var i;
		for (i = 0; i < tracks.length; i++) {
			if (tracks[i].mode === "showing") {
				active = i;
			}
			tracks[i].mode = "disabled";
		}
		var next = active + 1;
		if (next >= tracks.length) {
			toast("Text av");
			if (hls) { hls.subtitleTrack = -1; }
			return;
		}
		tracks[next].mode = "showing";
		if (hls) { hls.subtitleTrack = next; }
		toast("Text: " + (tracks[next].label || tracks[next].language || next));
	}

	function cycleAudioTracks() {
		if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
			var n = (hls.audioTrack + 1) % hls.audioTracks.length;
			hls.audioTrack = n;
			toast("Ljud: " + (hls.audioTracks[n].name || n));
			return;
		}
		var at = video.audioTracks;
		if (at && at.length > 1) {
			var cur = 0;
			for (var i = 0; i < at.length; i++) {
				if (at[i].enabled) { cur = i; }
			}
			var next = (cur + 1) % at.length;
			for (i = 0; i < at.length; i++) {
				at[i].enabled = (i === next);
			}
			toast("Ljud: " + (at[next].label || at[next].language || next));
			return;
		}
		toast("Bara ett ljudspår");
	}

	video.addEventListener("timeupdate", updateOsd);
	video.addEventListener("durationchange", updateOsd);
	video.addEventListener("progress", updateOsd);
	video.addEventListener("waiting", function () {
		elSpinner.hidden = false;
	});
	video.addEventListener("playing", function () {
		elSpinner.hidden = true;
		state("");
		showOsd(false);
	});
	video.addEventListener("pause", function () {
		state("Pausad");
		showOsd(true);
		savePos();
	});
	video.addEventListener("ended", function () {
		if (currentEntry) {
			try { localStorage.removeItem(posKey(currentEntry.id)); } catch (e) {}
		}
		stop();
	});
	video.addEventListener("error", function () {
		var e = video.error;
		toast("Uppspelningsfel" + (e ? " (kod " + e.code + ")" : ""), true);
		stop();
	});

	/* --------------------------------------------------------------- help */

	function helpHtml() {
		function rows(list) {
			return "<table>" + list.map(function (r) {
				return "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) +
					"</td><td>" + esc(r[2]) + "</td></tr>";
			}).join("") + "</table>";
		}
		return "<h2>Kontroller</h2><div class=\"cols\">" +
			"<div><h3>Bläddra</h3>" + rows([
				["✕", "Enter", "Öppna"],
				["○", "Escape", "Tillbaka"],
				["D-pad", "Piltangenter", "Flytta markören"],
				["L1 / R1", "F5 / F6", "Sida upp / ner"],
				["L2 / R2", "F7 / F8", "Först / sist"],
				["△", "F1", "Uppdatera listan"],
				["☰", "F3", "Den här hjälpen"]
			]) + "</div>" +
			"<div><h3>Spelare</h3>" + rows([
				["✕", "Enter", "Spela / pausa"],
				["○", "Escape", "Stäng spelaren"],
				["← →", "Piltangenter", "Spola 10 sekunder"],
				["↑ ↓", "Piltangenter", "Volym"],
				["L1 / R1", "F5 / F6", "Spola 1 minut"],
				["L2 / R2", "F7 / F8", "Spola 5 minuter"],
				["□", "F2", "Byt textspår"],
				["△", "F1", "Byt ljudspår"],
				["L3", "F9", "Börja om"],
				["R3", "F10", "Fyll skärmen / passa in"]
			]) + "</div></div>";
	}

	function toggleHelp() {
		if (mode === "help") {
			elHelp.hidden = true;
			mode = elPlayer.hidden ? "browse" : "player";
			return;
		}
		elHelp.innerHTML = helpHtml();
		elHelp.hidden = false;
		mode = "help";
	}

	/* ------------------------------------------------------------- input */

	function browseHints() {
		hints([
			["✕", "Öppna"],
			["○", "Tillbaka"],
			["L1/R1", "Sida"],
			["△", "Uppdatera"],
			["☰", "Hjälp"]
		]);
	}

	Input.setHandler(function (code) {
		if (mode === "help") {
			if (code === K.CIRCLE || code === K.OPTIONS || code === K.CROSS) {
				toggleHelp();
			}
			return;
		}

		if (mode === "player") {
			playerKey(code);
			return;
		}

		browseKey(code);
	});

	function browseKey(code) {
		switch (code) {
		case K.LEFT:  Input.move("left"); break;
		case K.RIGHT: Input.move("right"); break;
		case K.UP:    Input.move("up"); break;
		case K.DOWN:  Input.move("down"); break;
		case K.CROSS: openFocused(); break;
		case K.CIRCLE: back(); break;
		case K.L1:    Input.page(-CHUNK / 2, SCOPE); break;
		case K.R1:    drawChunk(); Input.page(CHUNK / 2, SCOPE); break;
		case K.L2:    Input.focusIndex(0, SCOPE); break;
		case K.R2:
			while (drawn < entries.length) { drawChunk(); }
			Input.focusIndex(Input.all(SCOPE).length - 1, SCOPE);
			break;
		case K.TRIANGLE:
			SVT.clearCache();
			toast("Uppdaterar…");
			render(stack[stack.length - 1]);
			break;
		case K.OPTIONS: toggleHelp(); break;
		default: break;
		}
	}

	function playerKey(code) {
		switch (code) {
		case K.CROSS:
			if (video.paused) {
				video.play();
			} else {
				video.pause();
			}
			showOsd(true);
			break;
		case K.CIRCLE:
			stop();
			break;
		case K.LEFT:  seek(-10); break;
		case K.RIGHT: seek(10); break;
		case K.L1:    seek(-60); break;
		case K.R1:    seek(60); break;
		case K.L2:    seek(-300); break;
		case K.R2:    seek(300); break;
		case K.UP:
			video.volume = Math.min(1, video.volume + 0.1);
			toast("Volym " + Math.round(video.volume * 100) + "%");
			showOsd(false);
			break;
		case K.DOWN:
			video.volume = Math.max(0, video.volume - 0.1);
			toast("Volym " + Math.round(video.volume * 100) + "%");
			showOsd(false);
			break;
		case K.SQUARE:   cycleTextTracks(); showOsd(false); break;
		case K.TRIANGLE: cycleAudioTracks(); showOsd(false); break;
		case K.L3:
			video.currentTime = 0;
			showOsd(false);
			break;
		case K.R3:
			video.style.objectFit =
				video.style.objectFit === "cover" ? "contain" : "cover";
			toast(video.style.objectFit === "cover"
				? "Fyller skärmen" : "Passar in bilden");
			break;
		case K.OPTIONS: toggleHelp(); break;
		default: break;
		}
	}

	/* --------------------------------------------------------------- boot */

	tickClock();
	setInterval(tickClock, 20000);
	browseHints();
	stack = [frameOf("start", null, null)];
	render(stack[0]);
}());
