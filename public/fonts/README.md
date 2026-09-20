# Northlake

The app's global body face. It is **not** bundled — Northlake is neither a system
font nor a Google font, so the file has to come from you.

## To make it render

Either install it on the machine, or drop the file here as one of:

```
public/fonts/Northlake.woff2      <- preferred: smallest, best supported
public/fonts/Northlake.woff
public/fonts/Northlake.otf
public/fonts/Northlake.ttf
```

Optionally a bold: `Northlake-Bold.woff2` (or `.otf` / `.ttf`).

Then `npm run build` and reload. Vite copies `public/` verbatim, so the file is
served at `/fonts/...` with no config.

## Why it is set up this way

`src/styles.css` declares `@font-face` with `local()` first and `url()` after, so
an installed copy is used without a download and a dropped-in file works as the
fallback. If neither exists, `--font` falls through to IBM Plex Mono and the app
looks unchanged rather than showing blank text.

## Converting a .otf or .ttf to .woff2

Not required — `.otf` and `.ttf` both work. `.woff2` is roughly half the size if
you want it:

```
npm i -g ttf2woff2
ttf2woff2 < Northlake.ttf > Northlake.woff2
```
