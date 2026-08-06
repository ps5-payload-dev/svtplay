var Input = (function () {
    "use strict";

    var KEY = {
	CROSS:    13,  // Enter
	CIRCLE:   27,  // Escape
	LEFT:     37,
	UP:       38,
	RIGHT:    39,
	DOWN:     40,
	TRIANGLE: 112, // F1
	SQUARE:   113, // F2
	OPTIONS:  114  // F3
    };

    // Held directions should repeat, but the browser's own key repeat on a
    // gamepad-driven key event is not something to rely on, so throttle it here
    // and let repeats through at a steady rate.
    var REPEAT_MS = 90;
    var lastRepeat = 0;

    // Every code in the pad mapping. Anything else is left to the browser, so a
    // text field added later still works.
    var HANDLED = [13, 27, 37, 38, 39, 40, 112, 113, 114];

    var handler = null;

    function setHandler(fn) {
	handler = fn;
    }

    function isDirection(code) {
	return code === KEY.LEFT || code === KEY.RIGHT ||
	    code === KEY.UP || code === KEY.DOWN;
    }

    document.addEventListener("keydown", function (e) {
	var code = e.keyCode || e.which;

	// Not every embedded build reports keyCode for Enter/Escape/arrows.
	if (!code && e.key) {
	    code = ({
		Enter: 13, Escape: 27, Esc: 27,
		ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
		F1: 112, F2: 113, F3: 114
	    })[e.key] || 0;
	}

	if (!code || !handler || HANDLED.indexOf(code) < 0) {
	    return;
	}

	// F1-F3 and the arrows would otherwise reach the browser chrome.
	e.preventDefault();
	e.stopPropagation();

	if (e.repeat && isDirection(code)) {
	    var now = Date.now();
	    if (now - lastRepeat < REPEAT_MS) {
		return;
	    }
	    lastRepeat = now;
	}

	handler(code, e);
    }, true);

    /* -------------------------------------------------------------- focus */

    function all(scope) {
	var root = scope || document;
	return Array.prototype.slice.call(
	    root.querySelectorAll(".focusable")
	).filter(function (el) {
	    return el.offsetParent !== null || el.offsetWidth > 0;
	});
    }

    function current(scope) {
	var root = scope || document;
	return root.querySelector(".focusable.focused");
    }

    function centre(el) {
	var r = el.getBoundingClientRect();
	return {
	    x: r.left + r.width / 2,
	    y: r.top + r.height / 2,
	    r: r
	};
    }

    // Nudge the element into view inside every scrollable ancestor, keeping a
    // margin so the next card along is always partly visible -- on a TV a card
    // flush against the edge reads as the end of the list.
    function reveal(el) {
	var p = el.parentElement;
	while (p && p !== document.body && p !== document.documentElement) {
	    var style = window.getComputedStyle(p);
	    var scrolls = /(auto|scroll)/.test(style.overflowX + style.overflowY);
	    if (scrolls) {
		var er = el.getBoundingClientRect();
		var pr = p.getBoundingClientRect();
		var padX = Math.min(120, pr.width * 0.12);
		var padY = Math.min(90, pr.height * 0.16);

		if (er.left < pr.left + padX) {
		    p.scrollLeft += er.left - pr.left - padX;
		} else if (er.right > pr.right - padX) {
		    p.scrollLeft += er.right - pr.right + padX;
		}
		if (er.top < pr.top + padY) {
		    p.scrollTop += er.top - pr.top - padY;
		} else if (er.bottom > pr.bottom - padY) {
		    p.scrollTop += er.bottom - pr.bottom + padY;
		}
	    }
	    p = p.parentElement;
	}
    }

    var onFocusChange = null;

    function setFocusListener(fn) {
	onFocusChange = fn;
    }

    function focus(el, scope) {
	if (!el) {
	    return null;
	}
	// Only ever one focused element in the app, whatever scope the caller
	// was indexing within -- otherwise the rail keeps its ring when the
	// cursor jumps into a freshly drawn listing.
	var was = document.querySelector(".focusable.focused");
	if (was && was !== el) {
	    was.className = was.className.replace(/\s*\bfocused\b/, "");
	}
	if (el.className.indexOf("focused") < 0) {
	    el.className += " focused";
	}
	reveal(el);
	if (onFocusChange) {
	    onFocusChange(el);
	}
	return el;
    }

    function focusFirst(scope) {
	return focus(all(scope)[0], scope);
    }

    function focusIndex(i, scope) {
	var items = all(scope);
	return focus(items[Math.max(0, Math.min(items.length - 1, i))], scope);
    }

    function indexOfFocused(scope) {
	return all(scope).indexOf(current(scope));
    }

    /*
     * Score = distance along the direction of travel + a heavy penalty for
     * drifting sideways, so pressing Down from the third card of a shelf lands
     * on the third card of the next one rather than on whatever happens to be
     * closest as the crow flies.
     */
    function move(dir, scope, nowrap) {
	var items = all(scope);
	var cur = current(scope);
	if (!items.length) {
	    return null;
	}
	if (!cur) {
	    return focus(items[0], scope);
	}

	var c = centre(cur);
	var best = null;
	var bestScore = Infinity;
	var SLACK = 6;

	items.forEach(function (el) {
	    if (el === cur) {
		return;
	    }
	    var t = centre(el);
	    var dx = t.x - c.x;
	    var dy = t.y - c.y;
	    var along, across;

	    if (dir === "left") {
		if (dx > -SLACK) { return; }
		along = -dx; across = Math.abs(dy);
	    } else if (dir === "right") {
		if (dx < SLACK) { return; }
		along = dx; across = Math.abs(dy);
	    } else if (dir === "up") {
		if (dy > -SLACK) { return; }
		along = -dy; across = Math.abs(dx);
	    } else {
		if (dy < SLACK) { return; }
		along = dy; across = Math.abs(dx);
	    }

	    // Overlapping on the cross axis means "same row" / "same column".
	    var overlap = (dir === "left" || dir === "right")
		? (t.r.bottom > c.r.top && t.r.top < c.r.bottom)
		: (t.r.right > c.r.left && t.r.left < c.r.right);

	    var score = along + across * (overlap ? 0.2 : 3);
	    if (score < bestScore) {
		bestScore = score;
		best = el;
	    }
	});

	// Nothing that way. In a wrapping grid, running off the end of a row
	// should continue on the next one rather than dead-end, so fall back to
	// document order for left/right. Callers that need to know they have
	// hit a real edge -- Left out of the listing and into the nav rail --
	// pass nowrap and get null instead.
	if (!best && !nowrap && (dir === "left" || dir === "right")) {
	    var i = items.indexOf(cur) + (dir === "right" ? 1 : -1);
	    best = items[i] || null;
	}

	return best ? focus(best, scope) : null;
    }

    return {
	KEY: KEY,
	setHandler: setHandler,
	setFocusListener: setFocusListener,
	all: all,
	current: current,
	focus: focus,
	focusFirst: focusFirst,
	focusIndex: focusIndex,
	indexOfFocused: indexOfFocused,
	move: move,
	reveal: reveal
    };
}());
