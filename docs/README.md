# SVT Play, browser edition

A standalone SVT Play client for an embedded WebKit driven by a DualSense.
No build step, no framework, no dependencies — three scripts and a stylesheet.

The API layer is a port of `plugins/svtplay.js` from jtplay: same persisted
GraphQL hashes, same entry model, same `resolve()` at playback time. The
blocking `http.get()` calls became `fetch()` promises, and DASH references are
dropped because a `<video>` element cannot play them without a separate MSE
player.

```
index.html        markup
css/app.css       palette and layout
js/svt.js         SVT Play API  (listings, artwork, stream resolution)
js/input.js       pad mapping and the focus engine
js/app.js         views, navigation stack, player
test/             headless smoke tests (needs `npm i jsdom`)
```

## Running it

Serve the directory over HTTP and open `index.html`:

```sh
python3 -m http.server 8080
```

`file://` may also work, but some WebKit builds treat it as an opaque origin
and refuse `fetch()` outright, so a static server is the safer starting point.

## Controls

| | | Browsing | Player |
|---|---|---|---|
| ✕ | Enter | Open | Play / pause |
| ○ | Escape | Back (or jump to the menu) | Close the player |
| D-pad | Arrows | Move the cursor | ← → seek 10 s · ↑ ↓ seek 5 min |
| △ | F1 | Refresh (drops the cache) | Cycle audio track |
| □ | F2 | — | Cycle subtitles |
| ☰ | F3 | On-screen key list | On-screen key list |

Movement is geometric rather than index-based: given a direction it takes the
nearest element that actually lies that way, weighting sideways drift heavily.
One rule covers the wrapping grids, the horizontal shelves on the start page
and the vertical nav rail, so no view describes its own layout. Running off the
end of a row in a grid continues on the next one instead of dead-ending.

## Colour

svtplay.se ships `theme-color: #000000` and a tile colour of `#242626`, so the
shell is black with graphite panels and white type. Green is reserved for one
job — showing where the focus is.

I could not pull SVT's exact brand green out of their bundle, so `--green` in
`css/app.css` is my read of it (`#2ec27e`). It is the single variable to change
if you want a closer match; nothing else references a green literal.

## Things worth knowing

**Persisted queries go stale.** SVT's GraphQL endpoint only accepts the sha256
of a query document it already knows. When SVT retires one, that listing starts
answering `PersistedQueryNotFound` and shows an error card while everything else
keeps working. The hashes are all in one table at the top of `js/svt.js`;
refresh them from svtplay.se's network traffic when a listing breaks.

**HLS.** Native playback is tried first via `canPlayType`. WebKit normally has
it, and that is the fast path — hardware decode, no MSE. If the check comes back
empty the player lazily pulls hls.js from jsdelivr, so that fallback needs
network access to the CDN. Format preference in `js/svt.js` puts AVC variants
ahead of HEVC, on the theory that an embedded build's HEVC support is a coin
flip; reorder `FORMATS` if yours handles HEVC fine.

**Long listings are chunked.** A–Ö is roughly 1500 shows in one response. The
grid draws 40 cards and extends as the cursor approaches the end, which keeps
the initial paint cheap. `CHUNK` in `js/app.js` is the knob.

**Playback position** is kept in `localStorage` for anything over five minutes
and offered as a resume, wrapped in try/catch since storage can be unavailable.

**No search.** The plugin has no persisted hash for it, and text entry with a
pad is its own project. A–Ö covers the whole catalogue in the meantime.

**Geo-blocking** shows up as HTTP 403 from the video API and surfaces as
"Inte tillgänglig från den här platsen".

## Tests

```sh
npm i jsdom && node test/smoke.js && node test/smoke-long.js
```

They stub `fetch` with fixtures shaped like the real Contento responses and a
fake layout, then drive the app with synthetic key events: navigation geometry,
the back stack and its focus restoration, chunked growth, format selection, and
the error path. They caught two bugs while I was building this, so they are
worth keeping as you extend it.
