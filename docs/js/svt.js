/*
 * SVT Play API.
 *
 * Listings come from SVT's Contento GraphQL endpoint, which only accepts
 * *persisted* queries (the client sends the sha256 of a query document the
 * server already knows), and playback goes through the separate video API,
 * which mints short-lived manifest URLs.
 *
 * When SVT retires a hash the API answers "PersistedQueryNotFound" and that
 * one listing stops working until the hash below is refreshed from svtplay.se.
 */
var SVT = (function () {
    "use strict";

    var VIDEO_API = "https://api.svt.se/video/";
    var QUERY_API = "https://api.svt.se/contento/graphql";
    var IMAGE_API = "https://www.svtstatic.se/image";
    var CLIENT_UA = "svtplaywebb-play-render-prod-client";

    // [operationName, sha256 of the query document]. Several listings share an
    // operation name with different documents, so the hash travels with the
    // call instead of being looked up by name.
    var OP = {
	CHANNELS:  ["ChannelsQuery",
		    "210be4b72f03223b990f031d9a2e3501ff9284f8d2c66b01b255a807775f0b19"],
	PROGRAMS:  ["ProgramsListing",
		    "17252e11da632f5c0d1b924b32be9191f6854723a0f50fb2adb35f72bb670efa"],
	GENRES:    ["MainGenres",
		    "65b3d9bccd1adf175d2ad6b1aaa482bb36f382f7bad6c555750f33322bc2b489"],
	CATEGORY:  ["CategoryPageQuery",
		    "00be06320342614f4b186e9c7710c29a7fc235a1936bde08a6ab0f427131bfaf"],
	GRID:      ["GridPage",
		    "a8248fc130da34208aba94c4d5cc7bd44187b5f36476d8d05e03724321aafb40"],
	DETAILS:   ["DetailsPageQuery",
		    "e240d515657bbb54f33cf158cea581f6303b8f01f3022ea3f9419fbe3a5614b0"],
	VIDEO_ID:  ["DetailsPageQuery",
		    "5be42eb4028ed8f2680ce2302f6887df3fed2dcb6f61ac091ff5a37a3d0bf477"]
    };

    // The curated rows of the start page: [id, name, description, selectionId].
    //
    // "live_start" is deliberately not among them: that selection is SVT's
    // schedule strip, so most of what it holds has not begun yet and none of it
    // is playable. Live channels are one press away under "Kanaler", where the
    // entries really are on air.
    var START_ROWS = [
	["popular",    "Populärt",      "Mest sedda",       "popular_start"],
	["latest",     "Senaste",       "Nyss tillagt",     "latest_start"],
	["lastchance", "Sista chansen", "Försvinner snart", "lastchance_start"]
    ];

    // __typename of the objects the API hands out. Anything else is dropped
    // rather than guessed at, so a new content type shows up as a line in the
    // console instead of an unplayable card.
    var SHOW_TYPES = ["TvShow", "KidsTvShow", "TvSeries"];
    var VIDEO_TYPES = ["Episode", "Clip", "Single", "Trailer", "Variant"];

    // Subheadings that only repeat what the card already says.
    var NOISE = /^(Idag|Ikväll|Igår|I morgon)\b|\b(sek|min|tim)$/i;

    // Only HLS is useful here: a <video> element plays it natively in WebKit,
    // and hls.js covers the rest. DASH needs a whole MSE player of its own, so
    // those references are skipped even when SVT offers them.
    var FORMATS = [
	"hls-ts-full", "hls-cmaf-full", "hls-ts-avc", "hls", "hls-cmaf-avc",
	"hls-ts-avc-51", "hls-cmaf", "hls-cmaf-live"
    ];

    // Listings get browsed back and forth (a show, back to the letter, the next
    // show), and A-Ö is one ~1500 item response, so keep answers around briefly.
    var CACHE_TTL_MS = 10 * 60 * 1000;
    var cache = {};

    function cached(key, produce) {
	var hit = cache[key];
	if (hit && Date.now() - hit.time < CACHE_TTL_MS) {
	    return hit.value;
	}
	var value = produce();
	cache[key] = {time: Date.now(), value: value};
	// A rejected promise must not be remembered as an answer.
	value["catch"](function () { delete cache[key]; });
	return value;
    }

    function clearCache() {
	cache = {};
    }

    function query(op, variables) {
	var extensions = {persistedQuery: {version: 1, sha256Hash: op[1]}};
	var url = QUERY_API +
	    "?ua=" + CLIENT_UA +
	    "&operationName=" + op[0] +
	    "&variables=" + encodeURIComponent(JSON.stringify(variables || {})) +
	    "&extensions=" + encodeURIComponent(JSON.stringify(extensions));

	return fetch(url, {headers: {Accept: "application/json"}})
	    .then(function (res) {
		if (!res.ok) {
		    throw new Error(op[0] + ": HTTP " + res.status);
		}
		return res.json();
	    })
	    .then(function (json) {
		if (json.errors && json.errors.length) {
		    // A stale hash lands here as "PersistedQueryNotFound".
		    throw new Error(op[0] + ": " + json.errors[0].message);
		}
		if (!json.data) {
		    throw new Error(op[0] + ": no data in response");
		}
		return json.data;
	    });
    }

    // Descriptions and headings arrive with markup in them now and then.
    function text(s) {
	if (!s) {
	    return "";
	}
	return String(s)
	    .replace(/<[^>]*>/g, "")
	    .replace(/&amp;/g, "&")
	    .replace(/&quot;/g, '"')
	    .replace(/&#39;/g, "'")
	    .replace(/&lt;/g, "<")
	    .replace(/&gt;/g, ">")
	    .replace(/\s+/g, " ")
	    .trim();
    }

    // Artwork is addressed by an id and the timestamp of its last change; the
    // service scales on the fly, so ask for the size actually being drawn.
    function imageUrl(img, width) {
	if (!img || !img.id) {
	    return "";
	}
	return IMAGE_API + "/wide/" + (width || 640) + "/" + img.id + "/" +
	    (img.changed || 0) + "?quality=70";
    }

    // Picks the best artwork an object carries, whatever shape it came in.
    function pickImage(obj, width, fallback) {
	var images = obj && obj.images;
	if (images) {
	    var img = images.wide || images.cleanWide || images.landscape;
	    if (img) {
		return imageUrl(img, width);
	    }
	}
	if (obj && obj.image) {
	    return imageUrl(obj.image, width);
	}
	return fallback || "";
    }

    function isShow(t) { return SHOW_TYPES.indexOf(t) >= 0; }
    function isVideo(t) { return VIDEO_TYPES.indexOf(t) >= 0; }

    // The id of a playable item: an svt id when the listing carries one (the
    // video API takes it directly), otherwise the svtplay path, which resolve()
    // trades for an svt id at the moment playback starts.
    function videoId(item) {
	var svtId = item.videoSvtId || item.svtId;
	if (svtId) {
	    return "video:" + svtId;
	}
	var path = item.urls && item.urls.svtplay;
	return path ? "path:" + path : "";
    }

    // Converts one Teaser (or a bare item, as search and the A-Ö listing hand
    // out) into an entry. Returns null for anything unplayable or unbrowsable.
    function toEntry(node, parentImage) {
	if (!node) {
	    return null;
	}

	// A Teaser wraps the real object and adds the display strings the site
	// shows for it; prefer those, they are the ones with episode numbers.
	var teaser = node.__typename === "Teaser" ? node : null;
	var item = teaser ? teaser.item : (node.item || node);
	if (!item) {
	    return null;
	}

	var typename = item.__typename;
	var name = text(teaser ? teaser.heading : "") || text(item.name);
	if (!name) {
	    return null;
	}

	// Episodes live under their show, so the heading alone ("Avsnitt 3")
	// is ambiguous once it turns up in a genre or a live row.
	var sub = teaser ? text(teaser.subHeading) : "";
	if (sub && sub !== name && !NOISE.test(sub)) {
	    name = name + " – " + sub;
	}

	var description =
	    text(teaser ? teaser.description : "") ||
	    text(item.longDescription) ||
	    text(item.description);
	var image = pickImage(teaser, 640, "") ||
	    pickImage(item, 640, parentImage);

	if (isShow(typename)) {
	    var path = item.urls && item.urls.svtplay;
	    if (!path) {
		return null;
	    }
	    return {
		id: "show:" + path,
		type: "folder",
		name: name,
		description: description,
		image: image
	    };
	}

	if (isVideo(typename)) {
	    var id = videoId(item);
	    if (!id) {
		return null;
	    }
	    return {
		id: id,
		type: "video",
		name: name,
		description: description,
		image: image
	    };
	}

	if (typename === "Genre") {
	    return {
		id: "genre:" + item.id,
		type: "folder",
		name: name,
		description: description,
		image: image
	    };
	}

	if (window.console) {
	    console.log("skipping unsupported type: " + typename);
	}
	return null;
    }

    function toEntries(nodes, parentImage) {
	var out = [];
	(nodes || []).forEach(function (node) {
	    var entry = toEntry(node, parentImage);
	    if (entry) {
		out.push(entry);
	    }
	});
	return out;
    }

    function dedup(entries) {
	var seen = {};
	return entries.filter(function (e) {
	    if (seen[e.id]) {
		return false;
	    }
	    seen[e.id] = true;
	    return true;
	});
    }

    /* ------------------------------------------------------------ listings */

    function channels() {
	return query(OP.CHANNELS).then(function (res) {
	    var list = (res.channels && res.channels.channels) || [];
	    return list.map(function (ch) {
		var running = ch.running || {};
		return {
		    id: "video:" + ch.id,
		    type: "video",
		    live: true,
		    name: ch.name,
		    description: running.name
			? text(running.name) +
			(running.description
			 ? " – " + text(running.description) : "")
			: "Direktsändning",
		    image: pickImage(running, 640, "")
		};
	    });
	});
    }

    // One of the curated rows of the start page.
    function selection(selectionId) {
	return cached("sel:" + selectionId, function () {
	    return query(OP.GRID, {
		selectionId: selectionId,
		includeFullOppetArkiv: true
	    }).then(function (res) {
		var sel = res.selectionById || {};
		return toEntries(sel.items);
	    });
	});
    }

    function startRows() {
	return START_ROWS.map(function (row) {
	    return {id: row[0], name: row[1], detail: row[2], selectionId: row[3]};
	});
    }

    // The whole A-Ö catalogue in one request; the letters are our own grouping
    // so that a page holds tens of cards rather than fifteen hundred.
    function allPrograms() {
	return cached("programs", function () {
	    return query(OP.PROGRAMS).then(function (res) {
		var selections =
		    (res.programAtillO && res.programAtillO.selections) || [];
		var entries = [];
		selections.forEach(function (sel) {
		    toEntries(sel.items).forEach(function (e) {
			entries.push(e);
		    });
		});
		entries = dedup(entries);
		entries.sort(function (a, b) {
		    return a.name.localeCompare(b.name, "sv");
		});
		return entries;
	    });
	});
    }

    // Everything that is not a Swedish letter goes into one bucket at the end,
    // which is where digits and the odd punctuated title land.
    function programLetter(name) {
	var first = name.charAt(0).toUpperCase();
	return /^[A-ZÅÄÖ]$/.test(first) ? first : "#";
    }

    function programLetters() {
	return allPrograms().then(function (entries) {
	    var counts = {};
	    var letters = [];
	    entries.forEach(function (e) {
		var l = programLetter(e.name);
		if (!counts[l]) {
		    counts[l] = 0;
		    letters.push(l);
		}
		counts[l]++;
	    });
	    // "#" sorts before "A" by code point but belongs last.
	    letters.sort(function (a, b) {
		if (a === "#") { return 1; }
		if (b === "#") { return -1; }
		return a.localeCompare(b, "sv");
	    });
	    return letters.map(function (l) {
		return {letter: l, count: counts[l]};
	    });
	});
    }

    function programsByLetter(letter) {
	return allPrograms().then(function (entries) {
	    return entries.filter(function (e) {
		return programLetter(e.name) === letter;
	    });
	});
    }

    function genres() {
	return cached("genres", function () {
	    return query(OP.GENRES).then(function (res) {
		var list = (res.genresInMain && res.genresInMain.genres) || [];
		return list.map(function (g) {
		    return {
			id: "genre:" + g.id,
			type: "folder",
			name: g.name,
			description: "",
			image: pickImage(g, 640, "")
		    };
		});
	    });
	});
    }

    function genre(id) {
	return cached("genre:" + id, function () {
	    return query(OP.CATEGORY, {
		id: id,
		tab: "all",
		includeFullOppetArkiv: true
	    }).then(function (res) {
		var page = res.categoryPage || {};
		var tabs = page.lazyLoadedTabs || [];
		var items = [];

		// Every tab carries a few themed rows; "all" is the full
		// listing and the only one that is not a subset of it.
		tabs.forEach(function (tab) {
		    (tab.selections || []).forEach(function (sel) {
			if (sel.selectionType === "all" || sel.id === "all") {
			    items = items.concat(sel.items || []);
			}
		    });
		});

		// Older documents only expose the rows, in which case take
		// them all and let the dedup sort out the overlap.
		if (!items.length) {
		    tabs.forEach(function (tab) {
			(tab.selections || []).forEach(function (sel) {
			    items = items.concat(sel.items || []);
			});
		    });
		}

		return dedup(toEntries(items));
	    });
	});
    }

    // The details page behind an svtplay path. Both show() and artwork() go
    // through here so that a poster fetched for a card is the same cached
    // response the show page is built from a moment later.
    function detailsPage(path) {
	return cached("show:" + path, function () {
	    return query(OP.DETAILS, {
		path: path,
		includeFullOppetArkiv: true
	    });
	});
    }

    // The A-Ö catalogue is a plain text listing: the document behind it hands
    // out names and paths and no artwork whatsoever, which is why those cards
    // came up bare. There is no bulk image endpoint to ask instead, so a card
    // without a picture fetches its own from the show's page; the caller is
    // expected to do that only for cards actually on screen.
    function artwork(id, width) {
	var path = "";
	if (id.indexOf("show:") === 0) {
	    path = id.substring(5).split("|")[0];
	} else if (id.indexOf("path:") === 0) {
	    path = id.substring(5);
	}
	if (!path) {
	    return Promise.reject(new Error("no path in " + id));
	}
	return detailsPage(path).then(function (res) {
	    var page = res.detailsPageByPath;
	    var url = page ? pickImage(page, width || 640, "") : "";
	    if (!url) {
		throw new Error("no artwork for " + path);
	    }
	    return url;
	});
    }

    // A show: its seasons, its clips, and whatever else SVT groups with it.
    // 'groupId' picks one of those groups once the viewer has opened it.
    function show(path, groupId) {
	return detailsPage(path).then(function (res) {
	    var page = res.detailsPageByPath;
	    if (!page) {
		throw new Error("no such show: " + path);
	    }

	    var image = pickImage(page, 640, "");
	    var head = {
		name: text(page.heading || page.name || ""),
		description: text(page.longDescription || page.description || ""),
		image: pickImage(page, 1280, "")
	    };

	    var groups = (page.associatedContent || []).filter(function (g) {
		// "upcoming" is unplayable, "related" is a different show.
		return g.id !== "upcoming" && g.id !== "related" &&
		    (g.items || []).length > 0;
	    });

	    if (groupId) {
		var group = groups.filter(function (g) {
		    return g.id === groupId;
		})[0];
		if (!group) {
		    throw new Error("no such section: " + groupId);
		}
		return {head: head, entries: toEntries(group.items, image)};
	    }

	    // One group is not worth a folder of its own; show the episodes.
	    if (groups.length === 1) {
		return {head: head, entries: toEntries(groups[0].items, image)};
	    }

	    return {
		head: head,
		entries: groups.map(function (g) {
		    return {
			id: "show:" + path + "|" + g.id,
			type: "folder",
			name: text(g.name) || g.id.replace(/-/g, " "),
			description: g.items.length + " videor",
			image: image
		    };
		})
	    };
	});
    }

    /* ----------------------------------------------------------- playback */

    // Trades an svtplay path for the svt id of the video on that page, for the
    // listings that give a path and no id.
    function svtIdForPath(path) {
	return cached("svtid:" + path, function () {
	    return query(OP.VIDEO_ID, {path: path}).then(function (res) {
		var page = res.detailsPageByPath;
		var svtId = page && page.video && page.video.svtId;
		if (!svtId) {
		    throw new Error("no video on " + path);
		}
		return svtId;
	    });
	});
    }

    // videoReferences carry either a ready manifest url or a 'resolve' endpoint
    // that redirects to one; the latter is what live channels use.
    function referenceUrl(ref) {
	if (!ref.resolve) {
	    return Promise.resolve(ref.url || "");
	}
	return fetch(ref.resolve, {headers: {Accept: "application/json"}})
	    .then(function (res) {
		return res.ok ? res.json() : null;
	    })
	    .then(function (json) {
		return (json && json.location) || ref.url || "";
	    })
	["catch"](function () {
	    return ref.url || "";
	});
    }

    // Subtitles do not travel inside SVT's HLS manifests: the video API lists
    // them separately as standalone files, so nothing the media element or
    // hls.js does on its own will ever surface them.
    var SUB_FORMATS = ["webvtt", "vtt", "websrt", "srt"];

    function subtitleList(video) {
	var refs = video.subtitleReferences || [];
	if (!refs.length && video.variants && video.variants["default"]) {
	    refs = video.variants["default"].subtitleReferences || [];
	}
	return refs.filter(function (ref) {
	    var f = String(ref.format || "").toLowerCase();
	    return ref.url && (SUB_FORMATS.indexOf(f) >= 0 ||
			       /\.(vtt|srt)(\?|$)/i.test(ref.url));
	}).map(function (ref, i) {
	    var f = String(ref.format || "").toLowerCase();
	    return {
		url: ref.url,
		srt: f.indexOf("srt") >= 0 || /\.srt(\?|$)/i.test(ref.url),
		language: ref.spokenLanguage || ref.language || "sv",
		// SVT labels these inconsistently; fall back to a number so two
		// unnamed tracks are still tellable apart.
		label: ref.label || ref.name || ref.title ||
		    (i === 0 ? "Svenska" : "Text " + (i + 1))
	    };
	});
    }

    function resolveStream(svtId) {
	return fetch(VIDEO_API + svtId, {headers: {Accept: "application/json"}})
	    .then(function (res) {
		if (!res.ok) {
		    // 403 is what a geo blocked title abroad looks like.
		    throw new Error(res.status === 403
				    ? "Inte tillgänglig från den här platsen"
				    : "video-API: HTTP " + res.status);
		}
		return res.json();
	    })
	    .then(function (video) {
		var refs = video.videoReferences || [];
		if (!refs.length && video.variants && video.variants["default"]) {
		    refs = video.variants["default"].videoReferences || [];
		}
		if (!refs.length) {
		    throw new Error("Inget att spela i " + svtId);
		}

		var drm = video.rights && video.rights.drmCopyProtection;

		var best = null;
		var bestRank = FORMATS.length;
		refs.forEach(function (ref) {
		    var format = String(ref.format || ref.playerType || "")
			.toLowerCase();
		    var rank = FORMATS.indexOf(format);
		    if (rank >= 0 && rank < bestRank) {
			best = ref;
			bestRank = rank;
		    }
		});

		// SVT renames formats now and then, so before giving up take
		// anything that looks like an HLS manifest.
		if (!best) {
		    best = refs.filter(function (ref) {
			return String(ref.url || "").indexOf(".m3u8") > 0;
		    })[0];
		}

		if (!best) {
		    throw new Error(drm
				    ? "Kopieringsskyddad"
				    : "Inget spelbart HLS-format för " + svtId);
		}

		return referenceUrl(best).then(function (url) {
		    if (!url) {
			throw new Error("Tom stream-URL för " + svtId);
		    }
		    if (window.console) {
			console.log("playing " + best.format + ": " + url);
		    }
		    return {
			url: url,
			format: best.format,
			subtitles: subtitleList(video)
		    };
		});
	    });
    }

    // Entry id -> manifest URL.
    function resolve(id) {
	if (id.indexOf("video:") === 0) {
	    return resolveStream(id.substring(6));
	}
	if (id.indexOf("path:") === 0) {
	    return svtIdForPath(id.substring(5)).then(resolveStream);
	}
	return resolveStream(id);
    }

    return {
	startRows: startRows,
	selection: selection,
	channels: channels,
	programLetters: programLetters,
	programsByLetter: programsByLetter,
	genres: genres,
	genre: genre,
	show: show,
	artwork: artwork,
	resolve: resolve,
	clearCache: clearCache
    };
}());
