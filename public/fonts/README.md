# Fonts

Nothing lives here any more, and nothing needs to.

The app used to carry two drop-in faces: **Northlake** as the body face and
**Ndot** as a dot-matrix display face, both declared against this folder with
`@font-face` and both falling back to something else until you supplied the
file. The redesign replaced the whole type system with three Google-hosted
faces, declared once in `index.html`:

| | |
|---|---|
| **Geist** | the UI — headings, labels, body |
| **Geist Mono** | anything that is a measurement: counts, times, ids, status |
| **Instrument Serif** *(italic)* | one word per empty state, and nothing else |

The `@font-face` blocks for Northlake and Ndot are gone from `src/styles.css`,
so dropping a file in here does nothing. To put a face back, add it to the
stack in the `:root` token block (`--font`, `--font-mono`, `--font-serif`) and
declare it — a `local()` source if it is installed, a `url('/fonts/…')` source
if you serve it from this folder, which Vite copies verbatim.

One warning worth keeping from the old version of this file: never point
`@font-face` at a URL that does not exist. The server answers any unknown path
with `index.html`, so the browser would fetch HTML, try to decode it as a font,
and fail on every single load.
