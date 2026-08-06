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

    // True while the cursor is sitting in the nav rail. Opening a rail item
    // loads its view but leaves the cursor on the menu, so the viewer can run
    // down Start / Kanaler / Program A-Ö and see each one without being thrown
    // into the listing; Right (or Cross on a card) is what hands focus over.
    var railLock = false;

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

    /* -------------------------------------------------------- pad glyphs */

    // Button prompts are drawn as small PNGs from img/btn. Every sprite shares
    // one 96x96 canvas, so a single square box lines the whole set up without
    // per-button nudging. The alt text is the old UTF-8 legend, which is what
    // a viewer sees if the sprite ever fails to load.
    var BTN = {
	cross:     ["cross",    "✕"],
	circle:    ["circle",   "○"],
	square:    ["square",   "□"],
	triangle:  ["triangle", "△"],
	options:   ["options",  "☰"],
	dpad:      ["dpad",     "D-pad"],
	"dpad-lr": ["dpad-lr",  "← →"],
	"dpad-ud": ["dpad-ud",  "↑ ↓"]
    };

    // A spec is whitespace separated: known names become sprites, anything
    // else is passed through as a literal, so "dpad / cross" keeps its slash.
    function glyphs(spec) {
	return String(spec).split(/\s+/).map(function (t) {
	    var b = BTN[t];
	    if (!b) {
		return '<i class="sep">' + esc(t) + "</i>";
	    }
	    return '<img class="btn" src="img/btn/' + b[0] + '.png" alt="' +
		esc(b[1]) + '">';
	}).join("");
    }

    // Decoding a sprite the first time it is inserted costs a frame, and the
    // help overlay is rebuilt every time it is opened. Warm them all up once.
    (function preloadGlyphs() {
	for (var k in BTN) {
	    if (Object.prototype.hasOwnProperty.call(BTN, k)) {
		new Image().src = "img/btn/" + BTN[k][0] + ".png";
	    }
	}
    }());

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

	return '<div class="card focusable" data-i="' + i + '"' +
	    (artable(entry) ? ' data-art="1"' : "") + ">" +
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
	scheduleArt();
    }

    // Called on every focus change: keep at least GROW_MARGIN cards drawn ahead
    // of the cursor so running down a long list never hits a wall.
    Input.setFocusListener(function (el) {
	if (!el || !el.getAttribute) {
	    return;
	}

	// The cursor is the only thing that decides whether the menu holds it.
	var rail = el.getAttribute("data-rail");
	railLock = !!rail;

	// Focusing a rail item is what opens it: the listing on the right
	// follows the cursor down the menu with no Cross needed.
	if (rail) {
	    activateRail(rail);
	}

	// Moving the cursor is the only kind of scrolling there is here, so it
	// is also when new cards come into view and want their artwork.
	scheduleArt();

	if (!gridEl) {
	    return;
	}
	var i = parseInt(el.getAttribute("data-i"), 10);
	if (!isNaN(i) && i > drawn - GROW_MARGIN) {
	    drawChunk();
	}
    });

    /* ----------------------------------------------------------- artwork */

    /*
     * Some listings arrive without pictures -- Program A-Ö above all, whose
     * document is a bare catalogue of names and paths -- and those cards used
     * to sit there as grey placeholders. There is no bulk image lookup to call,
     * so each bare card fetches its own poster from the show's page.
     *
     * That is one request per card, so only cards near the viewport ask, and
     * only a few at a time. The answer lands in the entry itself and in svt.js's
     * cache, so coming back to a letter is instant and opening the show costs
     * nothing extra.
     */
    var ART_PARALLEL = 3;
    var artQueue = [];
    var artActive = 0;
    var artTimer = null;

    // Which entries can be looked up at all: anything addressed by an svtplay
    // path. Genres and bare video ids have nowhere to fetch a picture from.
    function artable(entry) {
	return !entry.image &&
	    (entry.id.indexOf("show:") === 0 || entry.id.indexOf("path:") === 0);
    }

    function scheduleArt() {
	if (artTimer) {
	    return;
	}
	artTimer = setTimeout(function () {
	    artTimer = null;
	    artScan();
	}, 120);
    }

    // One screenful of slack in each direction, so a poster is usually there
    // before the cursor reaches the card.
    function artScan() {
	var cards = elContent.querySelectorAll(".card[data-art]");
	if (!cards.length) {
	    return;
	}
	var vw = window.innerWidth || 1920;
	var vh = window.innerHeight || 1080;

	for (var n = 0; n < cards.length; n++) {
	    var el = cards[n];
	    var r = el.getBoundingClientRect();
	    if (r.bottom < -vh || r.top > vh * 2 ||
		r.right < -vw || r.left > vw * 2) {
		continue;
	    }
	    // Claimed: whether it works or not, this card is not asked twice.
	    el.removeAttribute("data-art");
	    artQueue.push({el: el, token: token});
	}
	artPump();
    }

    function artPump() {
	while (artActive < ART_PARALLEL && artQueue.length) {
	    artFetch(artQueue.shift());
	}
    }

    function artFetch(job) {
	var i = parseInt(job.el.getAttribute("data-i"), 10);
	var entry = entries[i];
	if (job.token !== token || !entry) {
	    return;
	}

	artActive++;
	SVT.artwork(entry.id).then(function (url) {
	    if (job.token !== token || !job.el.parentNode) {
		return;
	    }
	    // Keep it on the entry too: a redraw of this listing, or a return
	    // to it while the cache is warm, then draws the card complete.
	    entry.image = url;
	    var thumb = job.el.querySelector(".thumb");
	    if (!thumb) {
		return;
	    }
	    thumb.insertAdjacentHTML("afterbegin",
				     '<img src="' + esc(url) + '" alt="" ' +
				     'onerror="this.style.display=\'none\'">');
	    var glyph = thumb.querySelector(".glyph");
	    if (glyph) {
		glyph.parentNode.removeChild(glyph);
	    }
	}, function () {
	    // No picture for this one: the placeholder glyph stays.
	})["catch"](function () {
	    return null;
	}).then(function () {
	    artActive--;
	    artPump();
	});
    }

    // Every "put the cursor somewhere in the listing" goes through these two, so
    // that a view loaded from the menu cannot steal it back.
    function focusContent(i) {
	if (railLock) {
	    return;
	}
	Input.focusIndex(i, SCOPE);
    }

    function focusFallback() {
	if (railLock) {
	    return;
	}
	Input.focusFirst();
    }

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
	    focusFallback();
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
	focusContent(want);
	scheduleArt();
    }

    /* --------------------------------------------------------------- rail */

    // The rail is rebuilt on every render, which threw away the focus ring along
    // with the old nodes. Remember which item had it and put it back on the new
    // node; the return value says whether the cursor is still in the menu, and
    // is what stops the fresh listing from grabbing it.
    function drawRail(currentView) {
	var focused = elRail.querySelector(".rail-item.focused");
	var keep = focused ? focused.getAttribute("data-rail") : null;

	elRail.innerHTML = RAIL.map(function (r) {
	    return '<div class="rail-item focusable' +
		(r.id === currentView ? " current" : "") +
		'" data-rail="' + r.id + '">' + esc(r.name) + "</div>";
	}).join("");

	if (keep) {
	    Input.focus(elRail.querySelector(
		'.rail-item[data-rail="' + keep + '"]'
	    ));
	    return true;
	}
	return false;
    }

    // Is the cursor in the menu right now? Asked of the DOM rather than kept in
    // a flag, because railLock answers a different question -- whether a listing
    // that arrives late is allowed to take the cursor.
    function inRail() {
	var el = Input.current();
	return !!(el && el.getAttribute && el.getAttribute("data-rail"));
    }

    // Which rail item the current stack belongs to. Read from the root frame,
    // so drilling into a show from Program A-Ö keeps Program A-Ö lit rather
    // than falling back to Start.
    function currentRoot() {
	return stack.length ? railIdOf(stack[0].view) : "start";
    }

    function focusRail() {
	Input.focus(elRail.querySelector(".rail-item.current") ||
		    elRail.querySelector(".rail-item"));
    }

    /*
     * Opening on focus means a held D-pad would fire a request per item on the
     * way past, so wait for the cursor to settle first. Anything that hands the
     * cursor to the listing flushes the pending load, so Right never lands in
     * the previous view's cards.
     */
    var RAIL_DELAY = 220;
    var railTimer = null;
    var railPending = null;

    function activateRail(id) {
	if (railTimer) {
	    clearTimeout(railTimer);
	    railTimer = null;
	}
	railPending = null;

	// Already showing it -- including the redraw that render() itself does,
	// which re-focuses this very item and would otherwise loop.
	if (!id || id === currentRoot()) {
	    return;
	}

	railPending = id;
	railTimer = setTimeout(function () {
	    railTimer = null;
	    openRail(railPending);
	}, RAIL_DELAY);
    }

    function flushRail() {
	if (!railTimer) {
	    return;
	}
	clearTimeout(railTimer);
	railTimer = null;
	openRail(railPending);
    }

    function openRail(id) {
	railPending = null;
	if (!id || id === currentRoot()) {
	    return;
	}
	stack = [frameOf(id === "programs" ? "letters" : id, null, null)];
	render(stack[0]);
    }

    // Hand the cursor from the menu to the listing. railLock is dropped first
    // so that a view still loading places the cursor when it arrives.
    function enterContent() {
	flushRail();
	railLock = false;
	var top = stack[stack.length - 1];
	Input.focusIndex(top ? top.focus : 0, SCOPE);
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
	    // Nothing to pop: treat Circle as "take me to the menu", landing on
	    // the entry this view belongs to rather than on the first one.
	    var top = stack[stack.length - 1];
	    if (top) {
		top.focus = Math.max(0, Input.indexOfFocused(SCOPE));
	    }
	    focusRail();
	    return;
	}
	stack.pop();
	render(stack[stack.length - 1]);
    }

    // Which rail entry a view belongs under.
    function railIdOf(view) {
	if (view === "programs" || view === "letters") {
	    return "programs";
	}
	if (view === "genre" || view === "genres") {
	    return "genres";
	}
	if (view === "channels") {
	    return "channels";
	}
	return "start";
    }

    function render(frame) {
	var my = ++token;
	railLock = drawRail(currentRoot());
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
	    focusFallback();
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
		focusContent(frame.focus);
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
	    if (placed || railLock) { return; }
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
		scheduleArt();

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
		    if (!placed) { focusFallback(); }
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

	// The view behind a rail item is already on screen -- focusing the item
	// loaded it -- so Cross is simply "into the listing", same as Right.
	if (el.getAttribute("data-rail")) {
	    enterContent();
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

    /* --------------------------------------------------------- stream info
     *
     * Nothing in the media element reports "what am I playing" directly, so
     * three sources are combined and whichever answers is used:
     *
     *   videoWidth/Height        always there, and it follows ABR switches
     *   webkit*DecodedByteCount  WebKit-only, differentiated into a real bitrate
     *   the master playlist      declared bandwidth, codecs and frame rate
     *
     * hls.js, when it is the one playing, knows all of it already. Every read
     * is guarded: an embedded build that exposes none of this still shows a
     * resolution, and the line simply gets shorter.
     */

    var elTech = document.getElementById("osd-tech");
    var variants = null;
    var manifestSubs = 0;
    var statsTimer = null;
    var statsPrev = null;
    var stats = {w: 0, h: 0, fps: 0, kbps: 0, dropped: 0, total: 0, buf: 0};

    function parseMaster(text) {
	var lines = String(text).split(/\r?\n/);
	var out = [];
	var i, m, a, v;
	manifestSubs = 0;
	for (i = 0; i < lines.length; i++) {
	    // Worth counting even though nothing uses them: it is the fastest
	    // way to tell a manifest that carries subtitles from one that does
	    // not, which is the whole question when text goes missing.
	    if (lines[i].indexOf("#EXT-X-MEDIA:") === 0 &&
		lines[i].indexOf("TYPE=SUBTITLES") > 0) {
		manifestSubs++;
	    }
	    if (lines[i].indexOf("#EXT-X-STREAM-INF:") !== 0) {
		continue;
	    }
	    a = lines[i].slice(18);
	    v = {bandwidth: 0, width: 0, height: 0, codecs: "", fps: 0};
	    m = /AVERAGE-BANDWIDTH=(\d+)/.exec(a);
	    if (m) { v.bandwidth = parseInt(m[1], 10); }
	    m = /[^-]BANDWIDTH=(\d+)/.exec(" " + a);
	    if (m && !v.bandwidth) { v.bandwidth = parseInt(m[1], 10); }
	    m = /RESOLUTION=(\d+)x(\d+)/.exec(a);
	    if (m) { v.width = parseInt(m[1], 10); v.height = parseInt(m[2], 10); }
	    m = /CODECS="([^"]*)"/.exec(a);
	    if (m) { v.codecs = m[1]; }
	    m = /FRAME-RATE=([\d.]+)/.exec(a);
	    if (m) { v.fps = parseFloat(m[1]); }
	    out.push(v);
	}
	return out.length ? out : null;
    }

    // The manifest is fetched a second time purely for its metadata. It is in
    // the CDN cache by now, and a CORS refusal is not worth reporting.
    function loadVariants(url) {
	variants = null;
	if (!window.fetch) {
	    return;
	}
	fetch(url, {credentials: "omit"}).then(function (r) {
	    return r.ok ? r.text() : "";
	}).then(function (t) {
	    variants = parseMaster(t);
	})["catch"](function () { /* measured values still work */ });
    }

    function codecName(s) {
	var seen = [];
	String(s).split(/[,\s]+/).forEach(function (c) {
	    var n = c.indexOf("hvc1") === 0 || c.indexOf("hev1") === 0 ? "HEVC"
		: c.indexOf("avc1") === 0 || c.indexOf("avc3") === 0 ? "H.264"
		: c.indexOf("av01") === 0 ? "AV1"
		: c.indexOf("vp09") === 0 ? "VP9"
		: c.indexOf("mp4a.40.5") === 0 ? "HE-AAC"
		: c.indexOf("mp4a") === 0 ? "AAC"
		: c === "ec-3" ? "Dolby Digital+"
		: c === "ac-3" ? "Dolby Digital"
		: c ? c : "";
	    if (n && seen.indexOf(n) < 0) { seen.push(n); }
	});
	return seen.join(" / ");
    }

    // Which rendition is on screen. hls.js says so; natively it has to be
    // inferred from the height, and where several renditions share a height
    // the measured bitrate breaks the tie.
    function variant() {
	var best = null;
	var i, v, d, bd;
	if (hls && hls.levels && hls.currentLevel >= 0) {
	    v = hls.levels[hls.currentLevel];
	    return {
		bandwidth: v.bitrate || 0,
		width: v.width || 0,
		height: v.height || 0,
		codecs: [v.videoCodec || "", v.audioCodec || ""].join(","),
		fps: v.frameRate || 0
	    };
	}
	if (!variants || !video.videoHeight) {
	    return null;
	}
	for (i = 0; i < variants.length; i++) {
	    v = variants[i];
	    if (v.height !== video.videoHeight) {
		continue;
	    }
	    if (!best) { best = v; continue; }
	    d = Math.abs(v.bandwidth / 1000 - stats.kbps);
	    bd = Math.abs(best.bandwidth / 1000 - stats.kbps);
	    if (stats.kbps && d < bd) { best = v; }
	}
	return best;
    }

    function quality() {
	if (video.getVideoPlaybackQuality) {
	    var q = video.getVideoPlaybackQuality();
	    return {
		total: q.totalVideoFrames || 0,
		dropped: q.droppedVideoFrames || 0
	    };
	}
	return {
	    total: video.webkitDecodedFrameCount || 0,
	    dropped: video.webkitDroppedFrameCount || 0
	};
    }

    function bufferAhead() {
	try {
	    var b = video.buffered;
	    for (var i = b.length - 1; i >= 0; i--) {
		if (b.start(i) <= video.currentTime && b.end(i) >= video.currentTime) {
		    return b.end(i) - video.currentTime;
		}
	    }
	} catch (e) { /* not seekable yet */ }
	return 0;
    }

    function sampleStats() {
	var now = Date.now();
	var q = quality();
	var bytes = (video.webkitVideoDecodedByteCount || 0) +
	    (video.webkitAudioDecodedByteCount || 0);
	var dt;

	stats.w = video.videoWidth || 0;
	stats.h = video.videoHeight || 0;
	stats.dropped = q.dropped;
	stats.total = q.total;
	stats.buf = bufferAhead();

	// A pause, a seek or a rendition change resets the counters; a negative
	// delta means the sample is meaningless rather than that nothing arrived.
	if (statsPrev && !video.paused) {
	    dt = (now - statsPrev.at) / 1000;
	    if (dt > 0.4) {
		if (bytes > statsPrev.bytes) {
		    stats.kbps = Math.round((bytes - statsPrev.bytes) * 8 / dt / 1000);
		}
		if (q.total > statsPrev.total) {
		    stats.fps = Math.round((q.total - statsPrev.total) / dt);
		}
	    }
	}
	statsPrev = {at: now, bytes: bytes, total: q.total};

	drawTech();
	if (mode === "help") {
	    drawHelpStats();
	}
    }

    function bitrateText() {
	var v = variant();
	if (stats.kbps > 50) {
	    return (stats.kbps / 1000).toFixed(1) + " Mbit/s";
	}
	if (v && v.bandwidth) {
	    return "~" + (v.bandwidth / 1e6).toFixed(1) + " Mbit/s";
	}
	return "";
    }

    function fpsText() {
	var v = variant();
	if (stats.fps > 5) {
	    return stats.fps + " fps";
	}
	return v && v.fps ? Math.round(v.fps) + " fps" : "";
    }

    function drawTech() {
	var v = variant();
	var out = [];
	if (stats.h) {
	    out.push(esc(stats.w + "×" + stats.h));
	}
	if (fpsText()) { out.push(esc(fpsText())); }
	if (bitrateText()) { out.push(esc(bitrateText())); }
	if (v && v.codecs) { out.push(esc(codecName(v.codecs))); }
	// Dropped frames are the one number worth colouring: on this hardware
	// they are the difference between "it plays" and "it plays smoothly".
	if (stats.dropped > 0) {
	    out.push('<span class="warn">' + stats.dropped + " tappade bilder</span>");
	}
	elTech.innerHTML = out.join(" · ");
    }

    function statsRows() {
	var v = variant();
	var rows = [];
	var pct = stats.total ? (stats.dropped / stats.total) * 100 : 0;

	rows.push(["Upplösning", stats.h ? stats.w + "×" + stats.h : "–"]);
	rows.push(["Bildfrekvens", fpsText() || "–"]);
	rows.push(["Bithastighet", bitrateText() || "–"]);
	if (v && v.codecs) { rows.push(["Kodek", esc(codecName(v.codecs))]); }
	// Three numbers, because "no subtitles" has three different causes:
	// none offered, offered but not fetched, fetched but not rendered.
	var shown = activeTrack();
	rows.push(["Textspår", subtitleTracks().length +
		   " (i manifest: " + manifestSubs + ", separata: " + subUrls.length + ")"]);
	rows.push(["Aktivt textspår", shown
		   ? esc(shown.label || shown.language || "?") + ", " +
		   (shown.cues ? shown.cues.length + " repliker" :
		    '<span class="warn">inga repliker inlästa</span>')
		   : "av"]);
	rows.push(["Buffert", stats.buf ? stats.buf.toFixed(1) + " s" : "–"]);
	rows.push(["Bilder", stats.total
		   ? stats.total + " avkodade, " +
		   (stats.dropped
		    ? '<span class="warn">' + stats.dropped + " tappade (" +
		    pct.toFixed(1) + " %)</span>"
		    : "0 tappade")
		   : "–"]);
	if (hls) {
	    rows.push(["Uppspelning", "hls.js " + (window.Hls.version || "")]);
	    if (hls.levels && hls.levels.length) {
		rows.push(["Kvalitetsnivå", (hls.currentLevel + 1) + " av " +
			   hls.levels.length + (hls.autoLevelEnabled ? " (auto)" : "")]);
	    }
	    if (hls.bandwidthEstimate) {
		rows.push(["Uppskattad bandbredd",
			   (hls.bandwidthEstimate / 1e6).toFixed(1) + " Mbit/s"]);
	    }
	} else {
	    rows.push(["Uppspelning", "WebKit HLS"]);
	    if (variants) {
		rows.push(["Renditioner", String(variants.length)]);
	    }
	}
	return rows;
    }

    function statsHtml() {
	return "<table>" + statsRows().map(function (r) {
	    return "<tr><td>" + esc(r[0]) + "</td><td>" + r[1] + "</td></tr>";
	}).join("") + "</table>";
    }

    function drawHelpStats() {
	var box = document.getElementById("help-stats");
	if (box) {
	    box.innerHTML = statsHtml();
	}
    }

    function startStats() {
	stopStats();
	statsPrev = null;
	stats = {w: 0, h: 0, fps: 0, kbps: 0, dropped: 0, total: 0, buf: 0};
	elTech.innerHTML = "";
	statsTimer = setInterval(sampleStats, 1000);
    }

    function stopStats() {
	if (statsTimer) {
	    clearInterval(statsTimer);
	    statsTimer = null;
	}
	variants = null;
	manifestSubs = 0;
	elTech.innerHTML = "";
    }

    // An ABR switch shows up here before the next sample tick.
    video.addEventListener("resize", drawTech);

    /* ----------------------------------------------------------- subtitles
     *
     * A cross-origin <track src> is blocked unless the video element carries
     * crossorigin="anonymous", and setting that would make every media segment
     * subject to CORS too -- a good way to lose playback entirely. So the file
     * is fetched here instead and handed to the element as a blob, which is
     * same-origin by definition. WebKit then parses the WebVTT itself, keeping
     * cue positioning and ::cue styling intact.
     */

    var subUrls = [];

    function srtToVtt(text) {
	return "WEBVTT\n\n" + String(text)
	    .replace(/^\uFEFF/, "")
	    .replace(/\r\n?/g, "\n")
	// 00:00:01,000 --> 00:00:04,000
	    .replace(/(\d\d:\d\d:\d\d),(\d{3})/g, "$1.$2");
    }

    function addSubtitle(sub, first) {
	return fetch(sub.url, {credentials: "omit"}).then(function (r) {
	    if (!r.ok) {
		throw new Error("HTTP " + r.status);
	    }
	    return r.text();
	}).then(function (text) {
	    var vtt = sub.srt || text.indexOf("WEBVTT") !== 0
		? srtToVtt(text)
		: text;
	    var url = URL.createObjectURL(new Blob([vtt], {type: "text/vtt"}));
	    var track = document.createElement("track");
	    subUrls.push(url);
	    track.kind = "subtitles";
	    track.label = sub.label;
	    track.srclang = sub.language;
	    track.src = url;
	    track["default"] = false;
	    video.appendChild(track);
	    // The element only exposes .track once it is in the document, and
	    // "disabled" keeps it out of the way until the viewer asks for it.
	    if (track.track) {
		track.track.mode = "disabled";
	    }
	    return true;
	});
    }

    function loadSubtitles(list) {
	clearSubtitles();
	if (!list || !list.length || !window.fetch || !window.URL ||
	    !window.URL.createObjectURL) {
	    return;
	}
	list.forEach(function (sub, i) {
	    addSubtitle(sub, i === 0)["catch"](function (err) {
		if (window.console) {
		    console.log("subtitle " + sub.url + ": " + err.message);
		}
	    });
	});
    }

    function clearSubtitles() {
	var nodes = video.querySelectorAll("track");
	for (var i = 0; i < nodes.length; i++) {
	    video.removeChild(nodes[i]);
	}
	subUrls.forEach(function (u) {
	    try { URL.revokeObjectURL(u); } catch (e) { /* already gone */ }
	});
	subUrls = [];
    }

    function play(entry) {
	currentEntry = entry;
	mode = "player";
	elPlayer.hidden = false;
	elSpinner.hidden = false;
	document.getElementById("osd-title").textContent = entry.name;
	document.getElementById("osd-desc").textContent = entry.description || "";
	document.getElementById("osd-state").textContent = "Laddar…";
	showOsd(true);
	startStats();

	SVT.resolve(entry.id).then(function (stream) {
	    if (mode !== "player") {
		return;
	    }
	    loadVariants(stream.url);
	    loadSubtitles(stream.subtitles);
	    return attach(stream.url, entry);
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
	stopStats();
	clearSubtitles();
	try { video.pause(); } catch (e) { /* not started */ }
	destroyHls();
	video.removeAttribute("src");
	try { video.load(); } catch (e) { /* ignore */ }
	elPlayer.hidden = true;
	elSpinner.hidden = true;
	currentEntry = null;
	mode = "browse";
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

    function subtitleTracks() {
	var out = [];
	var t = video.textTracks;
	var i;
	for (i = 0; t && i < t.length; i++) {
	    if (t[i].kind === "subtitles" || t[i].kind === "captions" ||
		!t[i].kind) {
		out.push(t[i]);
	    }
	}
	return out;
    }

    function activeTrack() {
	var tracks = subtitleTracks();
	for (var i = 0; i < tracks.length; i++) {
	    if (tracks[i].mode === "showing") {
		return tracks[i];
	    }
	}
	return null;
    }

    function cycleTextTracks() {
	var tracks = subtitleTracks();
	if (!tracks.length) {
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
	// A rendition hls.js owns has to be selected on the hls side too or no
	// cues are ever parsed into it. Match by label rather than by index:
	// the sidecar tracks share the same textTracks list and would otherwise
	// shift every hls index by however many of them were added.
	if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
	    var h = -1;
	    for (i = 0; i < hls.subtitleTracks.length; i++) {
		if ((hls.subtitleTracks[i].name || "") === tracks[next].label) {
		    h = i;
		}
	    }
	    hls.subtitleTrack = h;
	}
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

    /* help */

    function helpHtml() {
	function rows(list) {
	    return "<table>" + list.map(function (r) {
		return "<tr><td>" + glyphs(r[0]) + "</td><td>" + esc(r[1]) +
		    "</td><td>" + esc(r[2]) + "</td></tr>";
	    }).join("") + "</table>";
	}
	return "<h2>Kontroller</h2><div class=\"cols\">" +
	    "<div><h3>Bläddra</h3>" + rows([
		["cross", "Enter", "Öppna"],
		["circle", "Escape", "Tillbaka"],
		["dpad", "Piltangenter", "Flytta markören"],
		["triangle", "F1", "Uppdatera listan"],
		["options", "F3", "Den här hjälpen"]
	    ]) + "</div>" +
	    "<div><h3>Spelare</h3>" + rows([
		["cross", "Enter", "Spela / pausa"],
		["circle", "Escape", "Stäng spelaren"],
		["dpad-lr", "Piltangenter", "Spola 10 sekunder"],
		["dpad-ud", "Piltangenter", "Spola 5 minuter"],
		["square", "F2", "Byt textspår"],
		["triangle", "F1", "Byt ljudspår"]
	    ]) + "</div>" +
	    // The full stream readout only exists while something is playing.
	(elPlayer.hidden ? "" :
	 "<div><h3>Ström</h3><div id=\"help-stats\">" + statsHtml() +
	 "</div></div>") +
	    "</div>";
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

    /* input */

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
	case K.LEFT:
	    // Left off the edge of the listing goes to the menu -- to the item
	    // this view belongs to, not to whichever one happens to be level
	    // with the card. Remember where we were so Right comes back.
	    if (!inRail() && !Input.move("left", SCOPE, true)) {
		var top = stack[stack.length - 1];
		if (top) {
		    top.focus = Math.max(0, Input.indexOfFocused(SCOPE));
		}
		focusRail();
	    }
	    break;
	case K.RIGHT:
	    if (inRail()) {
		enterContent();
	    } else {
		Input.move("right", SCOPE);
	    }
	    break;
	case K.UP:    Input.move("up", inRail() ? elRail : SCOPE); break;
	case K.DOWN:  Input.move("down", inRail() ? elRail : SCOPE); break;
	case K.CROSS: openFocused(); break;
	case K.CIRCLE: back(); break;
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
	    // Left/Right nudge, Up/Down take the long stride. Both go through the
	    // same accumulator, so holding Down and then tapping Right adds up to
	    // one seek rather than a stutter of separate ones.
	case K.LEFT:  seek(-10); break;
	case K.RIGHT: seek(10); break;
	case K.DOWN:  seek(-300); break;
	case K.UP:    seek(300); break;
	case K.SQUARE:   cycleTextTracks(); showOsd(false); break;
	case K.TRIANGLE: cycleAudioTracks(); showOsd(false); break;
	case K.OPTIONS: toggleHelp(); break;
	default: break;
	}
    }

    /* boot */

    tickClock();
    setInterval(tickClock, 20000);
    stack = [frameOf("start", null, null)];
    render(stack[0]);

    // The rail exists as soon as render() has drawn it. Put the cursor on the
    // first item: that sets railLock, so Start fills the right-hand side as its
    // shelves arrive but leaves the cursor in the menu.
    Input.focus(elRail.querySelector(".rail-item"));
}());
