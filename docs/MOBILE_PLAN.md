# Case File on a phone — fix plan

Status (28 Oct 2026): **all six phases done and pushed.** Final audit at 375×667, 390×844,
430×932 and 844×390 landscape: no horizontal overflow, no text under 11px, every tap target
at least 40px. Desktop screens re-screenshotted and unchanged.

Found and fixed along the way, beyond the plan: a tap opened the top island and every
island on focus and folded it on the click (Android focuses buttons on tap); the body, not
the window, was the page's scroller; the touch sizing for pills inflated decorative source
labels on Reporting; inside a scrolling card, touch-action on the deck stopped applying.

Decided: Today and Notes go in the **top island menu**; the dashboard deck **swipes
sideways**; **iPhone** (Safari and the home-screen app) is tuned and tested first.

How this was found: every screen of the app, plus the to-do window and the notes pad, was
opened in Chrome emulating an iPhone (390×844, touch, iOS Safari user agent). Each screen was
screenshotted and measured: what runs off the edge, which controls are too small to tap, and
how much text is under 11px. The same script re-runs after every phase as the check.

---

## 1. What is wrong, and why

The root cause is one fact: **the app has no phone or touch rules at all.** There is not one
`(hover: none)` / `(pointer: coarse)` query in the stylesheets, and the 13 `max-width` queries
only resize the desktop grid. Everything else follows from the app assuming a mouse, a
keyboard and a wide window.

### Things you cannot do on a phone at all
| # | Problem | Why |
|---|---------|-----|
| 1 | **Open today's to-do** | Shift+T only. Phones have no Shift key. |
| 2 | **Open the notes pad** | Shift+N, or the tab on the left edge, which now stays invisible until a mouse comes near it. A finger never "comes near". |
| 3 | **Reach an entry's actions** (Sub, Today, Close, Delete) | They appear on hover. On the phone they are also pushed off the right edge of the screen (measured at x 368–478 on a 390 screen). |
| 4 | **Reorder today's to-do** | Drag and drop uses the browser's mouse-only drag events; the arrow buttons are hover-only. |
| 5 | **Page the dashboard cards** | The deck pages on the mouse wheel. The only touch route is seven 6×6px dots. |

### Things that render broken
| # | Screen | Problem |
|---|--------|---------|
| 6 | Case files | **Entry titles stack one letter per line** ("F / i / x / P / O / I / N / T"): the date pill, priority pill and actions take the row's width and squeeze the title to zero. |
| 7 | Case files, Reporting | Rows of choices (sub-cases, the case filter) are laid out wider than the screen (Reporting's track runs to x 1266); opening them on a phone would spill off the edge. |
| 8 | To-do window | The header's measurements print over "Today"; rows are cramped. |
| 9 | Dashboard | The brief and "up next" are indented ~50px to clear the notes tab's lane, which on a phone is a quarter of the width; titles truncate to "Sma…". The graph's node text is ~9px. |
| 10 | Notes pad | The tab rides out to the panel's edge and sits on top of the pad's content; no way to close without Escape or tapping the strip of page left beside it. |
| 11 | Everywhere | **Tap targets far below the 44px minimum**: priority/date pills 22px tall, ⋯ menus 24px, accent swatches 26px, calendar chips 31×17, month arrows 33×21, deck dots 6px. |
| 12 | Everywhere | Text under 11px: 25 pieces on the dashboard alone (graph nodes, mono labels). |

### iPhone-specific
| # | Problem | Effect |
|---|---------|--------|
| 13 | Text fields are 13–14px | **Safari zooms the whole page in** when you tap one (sign-in, Log an entry, titles), and you pinch back out every time. Anything under 16px does this. |
| 14 | No `viewport-fit=cover`, no safe-area padding | Installed on the home screen, the top bar sits under the notch / Dynamic Island and the bottom under the home indicator. |
| 15 | No standalone meta tags | The home-screen app shows Safari's chrome instead of opening full screen. |
| 16 | `100vh` in places | On iOS this is taller than the visible area when the toolbar is showing; things meant to fit the screen get cut off. |

### Weight
| # | Problem | Effect |
|---|---------|--------|
| 17 | Live background + 20-odd glass blurs + 3D tilt | Built for a desktop GPU. On a phone it costs battery and frames, and the tilt/parallax do nothing without a pointer. Glass Current needs WebGPU, which many phones lack (it falls back to Silk Fold). |

---

## 2. Approach

- **Same app, same look — a phone layer on top.** No separate mobile app or second design.
  Desktop is not touched: phone rules live under `(max-width: 640px)` and touch rules under
  `(hover: none) and (pointer: coarse)` (an iPad with a keyboard and trackpad keeps the
  desktop behaviour).
- **Touch has its own way into every feature** the keyboard and the mouse have.
- **Measured, not eyeballed:** the audit script must report zero overflow, no tap target
  under 40px and no text under 11px before a phase is called done, at 375, 390 and 430 widths
  (small iPhone, iPhone, Pro Max) and in landscape.
- Each phase is pushed on its own; Vercel redeploys in a minute and you check it on the phone.

---

## 3. Phases

### Phase 1 — Foundations (every screen at once)
1. `index.html`: `viewport-fit=cover`; `apple-mobile-web-app-capable`,
   `mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`;
   manifest `theme_color`/`background_color` matched to the app.
2. Safe areas: top bar, panels and sheets padded with `env(safe-area-inset-*)`.
3. Every text field 16px on touch screens (stops Safari's zoom), visual size kept by the
   surrounding layout.
4. Touch layer `(hover: none)`: everything that only appears on hover is shown (entry
   actions, to-do row controls); hit areas grown to 44px with invisible padding where the
   visible control should stay small (pills, swatches, chips, dots).
5. Phone typography floor: nothing under 11px; the mono labels and graph nodes scale up.
6. `100vh` → `100dvh` where a thing must fit the visible screen.
7. Touch devices: no 3D tilt or pointer parallax; the background draws fewer strands and
   the glass blur is lighter. (Your chosen effect is kept; only its weight changes.)

### Phase 2 — Touch entry points
1. **Today and Notes in the top island.** Tapping the page pill already opens the list of
   screens; it gains two rows under a divider: *Today's to-do* and *Notes*. (Alternative: a
   small two-button dock at the bottom of the screen — see §4.)
2. On touch the notes tab is always visible (no hover to reveal it), parked so it covers
   nothing.
3. To-do window and notes pad open as **bottom sheets** on a phone: full width, rounded top,
   a grab handle, swipe down or tap the backdrop to close, and a visible close button —
   because there is no Escape key.

### Phase 3 — Case files
1. **Entry rows restack** on a phone: title on its own full-width line; due and case beneath;
   then one row of controls — date, priority, and the actions as icons (Today, Close, Sub,
   ⋯ with Delete inside). Always visible.
2. Case bar: folder and case islands on one line, *New case* as a + icon.
3. Sub-cases and other rows of choices open as a horizontal strip that scrolls with a
   finger, clamped to the screen.
4. Case structure card: shorter on a phone; the graph fits the width with legible nodes, and
   tapping it opens the full-window view (already exists) where it can be panned.
5. Drag-to-nest on a phone: long-press an entry to pick it up (the desktop drag is mouse-only).

### Phase 4 — Dashboard
1. No notes-tab indent on a phone.
2. *Up next* as two-line rows: the title in full, then the case and when it is due.
3. The card deck: **swipe sideways** between cards on touch, with larger dots
   (or stacked vertically — see §4).
4. Graph card: nodes and text sized for the width.

### Phase 5 — To-do, Reporting, Calendar, Settings
1. To-do: header measurements on their own line; rows with always-visible controls;
   **long-press and drag to reorder** (pointer events, works for touch and mouse), up/down
   kept as the accessible fallback.
2. Reporting: the case filter becomes a select on a phone; long tables keep their columns
   readable (check the full 9,000px page section by section).
3. Calendar: month chips and arrows at full tap size; the class week scrolls sideways; the
   hover cards become tap cards.
4. Settings: 36px swatches with 44px hit areas; the header line wraps cleanly.
5. Sign-in: 16px field (no zoom).

### Phase 6 — Verify
1. The audit at 375 / 390 / 430 and landscape: zero overflow, targets ≥ 40px, text ≥ 11px.
2. Screenshots of every screen and every sheet, before and after, for you to compare.
3. You on your actual phone after each phase's deploy; anything that still feels off gets
   fixed in the same phase.

---

## 4. Decisions for you
| Decision | Options | Recommendation |
|----------|---------|----------------|
| Where Today and Notes live on a phone | In the top island's menu, or a small dock at the bottom | **Top island** — no new chrome on screen, and it is already where you go to move around |
| Dashboard cards on a phone | Swipe sideways one at a time, or stack them all vertically | **Swipe** — keeps the one-card-at-a-time feel of the desktop |
| Which phone to tune for first | iPhone (Safari) or Android (Chrome) | Whatever you use; both get the same fixes, but the one you use gets tested first |

---

## 5. Order and size
| Phase | Size | Why this order |
|-------|------|----------------|
| 1 Foundations | medium | Fixes the zoom, the notch, hover-only controls and tap sizes on every screen at once |
| 2 Touch entry points | medium | Makes To-do and Notes usable on the phone at all |
| 3 Case files | large | The most broken screen and the one used most |
| 4 Dashboard | medium | |
| 5 To-do / Reporting / Calendar / Settings | medium | |
| 6 Verify | short | Runs after each phase too |
