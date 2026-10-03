# Case

A local-first case tracker. Work is grouped into **cases**, each holding **entries** with
due dates, priorities and nested subtasks; the app reads that back to you as a dashboard
rather than a to-do list — completion rates, what is overdue, what is stalled, and a
weekly class timetable read straight from a registrar `.ics` export.

Everything runs on your own machine against a local SQLite file. There is no account, no
sync and no telemetry.

One part is opt-in and does leave the machine: **the clerk**, an agent that files your
notes into the archive, writes the day's brief and answers questions about what you have
logged. It does nothing until you put an API key in `.env` yourself — see
[The clerk](#the-clerk).

![The dashboard](docs/screenshots/dashboard.png)

---

## Screens

| | |
|---|---|
| **Dashboard** | A greeting and what is coming on the left; one card at a time on the right, paged with the wheel. The case structure comes first, then workload, recommendations, tracking, the weekly report and the completion rate. |
| **Case files** | The working screen. Create, rename, reorder and delete cases; add sub-cases; log entries with dates and priorities; nest subtasks under an entry. |
| **Reporting** | Every open entry bucketed by due day — Overdue / This week / Later — plus a world-news feed from public RSS. |
| **Calendar** | Two calendars over the same days. **Entries** is a month grid of every dated entry in the archive, coloured by how its deadline stands, and clicking one opens its case. **Classes** is a weekly timetable parsed from `src/data/class-calendar.ics`, with next class, today's agenda and term progress. |
| **Flashcards** | Import a deck from a `.json` file or pasted text — or paste a lecture and have the clerk draft one — file it under a course, and review it on an SM-2 spaced schedule. The scheduling is offline SM-2 and always has been; only drafting a new deck calls a model, and only when you ask it to. |
| **Settings** | Motion preferences, including a reduced-motion override. |

A scratchpad sits behind a tab on the left edge of every screen: a page slides out with
nothing on it but somewhere to type. It saves as you go and follows you between screens.
With a key configured it is also where filing happens: **File it** hands the pad to the
clerk, which proposes entries you review before anything is written.

![Case files](docs/screenshots/case-files.png)

Entries come first on the Case files screen, with the diagram behind them — the two dots
at the corner switch between them. **Dragging one entry onto another files it as a
subtask**, and dragging it onto an entry in a different case moves it there. Subtasks stay
one level deep, so an entry that already holds subtasks cannot itself become one.

### The case-structure diagram

![The case structure](docs/screenshots/case-structure.png)

The centrepiece of the Dashboard and Case files screens: a case drawn as a **flow**. The
case is the first step, its entries are the steps that come off it, and a subtask is a step
off an entry. Each one is a card with a name and a line of data under it, and the lines
between them are curves leaving one card's right edge and arriving at the next one's left.

It replaced a force-directed graph, and the difference is the point. A simulation decides
where things go and you read the result; a flow is laid out — left to right, each parent
level with the middle of its own children — so the same case comes out the same shape every
time, the lines never cross, and the drawing says what belongs to what rather than what
happens to be near what.

Colour means state and nothing else: **white** open, **amber** due soon, **red** overdue,
**violet** closed. Hovering a step lifts it, brings its own wires up with it and steps the
rest back, so one branch can be followed through a busy case without reading every card on
the way.

It is built as HTML cards over a single SVG of wires rather than as one drawing. Text in
SVG cannot wrap, cannot ellipsis and does not inherit the app's type scale, and a card full
of real words needs all three. The whole thing is laid out at its own size and scaled to
fit as one piece — measured off the layout box rather than the painted one, because this
panel is routinely painted through a transform and the painted box is a lie.

**The panel it sits on turns.** It carries the only 3D in the app: a `perspective` on the
grid, and this one card rotating several degrees to face the pointer while every other
panel holds still. One panel turning against eleven still ones is unmistakably an object
standing in front of them; a whole room moving together is a wobble.

---

## The clerk

An agent over the archive, in four places. It is off unless an API key is present, and
with no key none of it appears anywhere in the app.

**Filing — the scratchpad.** Paste a syllabus week, an email, a list of deadlines, a brain
dump. **File it** hands the pad to the clerk, which reads your existing cases so it does
not duplicate them and your timetable so it can resolve *week 9* and *before the midterm*,
and comes back with proposed rows: `Assignment 3 · CS 341 · due Fri 17 Oct · high`. Each
one carries the few words from your own text that produced it. Edit a date, drop two,
accept the rest. The pad is never cleared — the same notes are often filed twice as a week
goes on.

**The brief — the dashboard.** Two or three sentences under the headline, saying the thing
the counts cannot: which one to do first, and whether there is actually room for it between
today's classes. Cached against the facts that produced it, so opening the dashboard four
times before lunch costs one call, and ticking something overdue off is what makes it
rewrite.

**The chat card — second in the dashboard deck.** Questions about the archive, answered out
of it. It can open a case, search the entries and read the timetable before answering, and
it says underneath what it looked at. It cannot change anything, and says so if you ask it
to.

**Writing a deck — Flashcards.** Paste a lecture, a chapter or a set of notes and the clerk
drafts cards from it. You read the draft and cut, because a model will write forty cards
where thirty are worth reviewing — and importing all forty does not cost you ten bad cards
once, it costs you them on a spaced schedule for months, with the schedule preferentially
showing you the ones you keep failing. The material is kept as the deck's source, so a deck
written this way is no less traceable than one imported from a file.

### Reads loop, writes are proposals

The clerk has four tools and every one of them reads: `case_detail`, `search_entries`,
`timetable`, `standing`. It calls them in a loop, because deciding whether a case for a
course already exists genuinely requires looking.

It has no tool that writes. Everything it wants to change comes back as a list you approve,
and applying it is a separate request that validates the rows again — by then they have
been through a browser and been edited, so they are untrusted input whatever the model
originally said. The whole filing applies in one transaction or not at all.

This is not timidity about the model. A filing assistant you have to audit afterwards is
slower than filing it yourself: reviewing nine proposed rows takes ten seconds, and finding
the three an unattended agent got wrong takes longer than typing all nine.

The brief never counts anything. It is handed the numbers — computed by `src/lib/metrics.js`,
the same module the screen renders from — and asked to interpret them. One visibly wrong
number costs more trust than the whole feature earns.

### Setting it up

Both providers have a free tier, and one key is a complete installation.

| | where | what it is used for |
|---|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/apikey) | Filing and deck-writing. A huge context window, so a syllabus plus your whole archive fits in one call. |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com/keys) | The brief and the chat. It answered in 84ms in testing, which is most of what makes those two feel good. |
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai/keys) | Fallback, used only if neither of the above is set. |

Put one or both in `.env` and restart. **With both, each job also falls over to the other
when it hits a limit** — the two free tiers are capped along completely different axes
(Gemini by requests per minute, Groq by 8000 tokens per minute against 1000 requests a
day), so the wall one hits is usually one the other would not have noticed.
`CLERK_PROVIDER=groq` pins every job to one of them and disables the fall-over, which is
what makes "is it the model or is it me" answerable without editing code.

Everything speaks one wire format — OpenAI's chat-completions shape, which Groq serves
natively and Google publishes a compatible endpoint for. That is why there are two free
tiers and one code path rather than two SDKs and a translation layer between them.

### When a model name stops working

They rot, and without warning. Groq retired `llama-3.3-70b-versatile` during this build,
and Google's model list still advertises `gemini-2.5-flash` while the OpenAI-compatible
endpoint returns 404 for it. So the defaults are overridable without touching code —
`CLERK_GEMINI_MODEL`, `CLERK_GROQ_MODEL`, `CLERK_OPENROUTER_MODEL` — and the error the app
shows says so by name rather than passing the provider's "that model does not exist"
straight through. To see what a key can actually call:

```bash
curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models
```

Being in the list is not enough, though: a model also has to call a tool when given one
and honour a JSON schema when asked, and they fail those independently. The defaults were
each picked by calling them and checking all three.

### What leaves the machine

When you file the pad, ask the chat a question, draft a deck or the brief regenerates: the
text involved, your case names, the entries in them and the courses on your timetable are
sent to whichever provider is configured. **Nothing is sent at any other time** — there is
no background call, no analytics, no sync. Settings has a panel saying this on screen, with
which provider is answering which job.

Remove the key and restart to turn it off. Verified rather than asserted: with no key the
app makes no request to any model provider from anywhere, and the only thing that leaves the
machine is the three typefaces it has always fetched from Google Fonts.

---

## Running it

Requires **Node 24 or newer** — the server uses the built-in `node:sqlite` module and
`--env-file`, both of which are unavailable on older releases.

```bash
npm install
cp .env.example .env      # required: node --env-file fails if the file is absent
npm run app               # build the frontend, then serve everything on :4001
```

Optionally drop your own timetable in as `src/data/class-calendar.local.ics` — see
[Swapping in your own class schedule](#swapping-in-your-own-class-schedule).

Then open <http://localhost:4001>.

The database is created and seeded with sample cases on first run at
`server/case-file.sqlite`. That file is deliberately **not** tracked by git — it holds
real content, not fixtures.

### Other scripts

| command | what it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload, plus the API on `:4001` |
| `npm run server` | API only, restarting on change |
| `npm run build` | Production build into `dist/` |
| `npm start` | Serve an existing build |

`.env` needs no secrets to run the app — only `PORT` is read, and it defaults to `4001`.
An API key there is what turns [the clerk](#the-clerk) on; without one the app never calls
a model.

---

## Swapping in your own class schedule

The Calendar screen's **Classes** view has nothing hard-coded. It parses a registrar `.ics` export, so
a new term is a file swap:

1. Download the `.ics` from your student portal.
2. Save it as **`src/data/class-calendar.local.ics`**.
3. Rebuild.

Courses, rooms, meeting times, holidays and the term's length all follow from the file.

The repo ships a fictional `src/data/class-calendar.ics` so a fresh clone builds and the
screen has something to draw — it is labelled *sample data* in the header. Your own
schedule goes in the `.local.ics` name, which is gitignored and takes precedence whenever
it exists. A real timetable is personal (course names, buildings, room numbers), and it
should not end up in anyone's git history, including yours.

Two things worth knowing about the parser (`src/lib/ics.js`):

- **Times are read as wall-clock, not converted.** A 09:30 class reads 09:30 wherever you
  open the app. That is the right answer for the person walking to it, and the only honest
  option without shipping a timezone database — but open it from another timezone and the
  times are still campus times, not yours.
- It handles weekly `RRULE`s with `BYDAY`/`UNTIL` and subtracts `EXDATE` holidays, which is
  the whole of what a class schedule uses. Anything it does not understand is skipped
  rather than guessed at, so an unfamiliar export loses events instead of inventing them.

---

## Layout

```
server/
  index.js      Express API + static hosting for the built frontend
  db.js         schema, migrations and first-run seed
  news.js       RSS fetch and place-name resolution for Reporting
  ai.js         the only file that talks to a model, and the only one that sees a key
  archive.js    the archive as JSON, plus the facts the clerk is handed
  clerk.js      the agent: read tools, the loop, filing / brief / chat / decks
src/
  views/        one file per screen
  ui/           primitives, charts, the case graph, the scratchpad drawer
  lib/          API client, metrics, the graph builder, SM-2, .ics parsing
  data/         the sample class-calendar .ics
  styles.css    the design system — every colour is a token here
  motion.css    the assembly and transition choreography
```

### Stack

React 19 and Vite on the front, Express on the back, SQLite through Node's built-in
`node:sqlite`. No ORM, no state library, no CSS framework. Icons are `lucide-react`;
`compromise` and `fast-xml-parser` serve the news feed.

---

## Notes on the design

Near-black ground, one violet accent, and panels of dark glass over a slow-moving bundle of
light. Three faces, each with one job: a geometric sans for the UI, a monospace for
anything that is a measurement rather than a sentence — counts, times, ids, status — and
an italic serif used on exactly one word, the last word of an empty state.

**One panel turns.** The bento grid carries a `perspective` whose vanishing point follows
the pointer, and the panel holding the case graph rotates several degrees to face it and
steps toward the eye. Everything else holds still, which is the point: when the whole room
moves together there is nothing for the eye to measure the movement against, and a dozen
surfaces each at a slight angle reads as a wobble. Hold the grid still and turn one panel
hard, and that panel is unmistakably an object standing in front of the others. It has to
be a rotation rather than a slide, too — a flat translate has no foreshortening in it, and
foreshortening is the only thing the eye accepts as depth.

One listener on the window writes the pointer as `--px` and `--py` on the root element;
the turn, the vanishing point and the streak's own drift all read those two numbers, so
there is exactly one listener and no re-render.

The light is a canvas behind everything (`src/ui/Streak.jsx`): a hundred-odd bezier
strands pulled through a focal point in the lower-left and fanned across the right,
undulating on gradient noise. One stroke per strand with a gradient along it, rather than
a chain of segments, is what keeps it free: measured against an idle baseline on the same
browser, the dashboard holds 60fps with it running. It stops dead when the tab is hidden,
thins out on a small screen, and paints a single still frame under `prefers-reduced-motion`.

Three conventions are load-bearing, and breaking any of them shows immediately:

- **`src/styles.css` is the only place a colour is written down.** Components reference
  tokens; they never contain a hex value. The graph follows this too: each node group sets
  one custom property and its dot and its label both read from that, so they cannot
  disagree about what state the entry is in. The streak's canvas is no exception: it
  parses the accent out of the stylesheet at mount rather than carrying its own copy.
- **The accent is the only saturated colour in the chrome**, and it is spent on three:
  the primary action, the active state, and done. Amber and red are not decoration either
  — they mean due soon and overdue, and nothing else in the app may borrow them.
- **Animations must fail safe.** Every hidden-start animation is gated behind a class that
  is removed once the sequence is spent, so an animation that cannot run leaves content
  visible rather than stranded at `opacity: 0`.

`prefers-reduced-motion` is honoured throughout, and can be forced on from Settings. The
graph honours it by running its simulation to convergence in one synchronous pass and
painting the settled result — a reduced-motion reader gets the same graph, not an empty
box.
