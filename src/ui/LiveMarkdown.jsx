/**
 * LiveMarkdown.jsx — a markdown editor that renders as you go, the way
 * Obsidian's live preview does.
 *
 * Every line shows its rendered form — headings sized, emphasis applied, list
 * dashes turned into bullets, the syntax characters gone — except the line the
 * cursor is on, which shows its raw source so it can be edited. Move off a line
 * and it renders; move back and the markdown reappears.
 *
 * Built on CodeMirror 6, which is what Obsidian's editor is built on too. The
 * rendering is not a second copy of the text: it is a set of decorations laid
 * over the one document — some hide characters, some style ranges, some swap a
 * marker for a widget. The text underneath never changes, so what is saved is
 * always plain markdown, and a note written before this existed is already
 * valid input.
 */

import { useEffect, useRef } from 'react';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageSupport, syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';

/* Marks a transaction as coming from outside — the saved text arriving from the
   server — so the change listener does not echo it straight back as an edit. */
const External = Annotation.define();

/* ---- widgets ------------------------------------------------------------- */

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'md-bullet';
    s.textContent = '•';
    return s;
  }
}

/* A task box that works: clicking it rewrites the [ ] or [x] in the source,
   which is the whole state of the task — there is nothing else to keep in step. */
class TaskWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'md-task';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' },
      });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const hr = document.createElement('span');
    hr.className = 'md-hr';
    return hr;
  }
}

/* ---- which lines stay raw ------------------------------------------------- */

/* Every line touched by the selection, and only while the editor has focus. An
   unfocused note should read as a finished page, not as one with a line still
   open for editing. */
function activeLines(view) {
  const lines = new Set();
  if (!view.hasFocus) return lines;
  const { doc } = view.state;
  for (const r of view.state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let n = a; n <= b; n += 1) lines.add(n);
  }
  return lines;
}

const hide = Decoration.replace({});
const mark = (cls) => Decoration.mark({ class: cls });
const line = (cls) => Decoration.line({ class: cls });

const INLINE = {
  StrongEmphasis: 'md-strong',
  Emphasis: 'md-em',
  InlineCode: 'md-code',
  Strikethrough: 'md-strike',
  Link: 'md-link',
};

/* Markers that disappear when their line is not being edited. */
const MARKERS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL', 'QuoteMark']);

function build(view) {
  const { state } = view;
  const { doc } = state;
  const raw = activeLines(view);
  const out = [];
  const isRaw = (pos) => raw.has(doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        /* Headings size their whole line either way, so the text does not jump
           in size as the cursor arrives — only the # marks come and go. */
        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) {
          out.push(line(`md-h md-h${h[1]}`).range(doc.lineAt(node.from).from));
          return;
        }
        if (name === 'Blockquote') {
          for (let p = node.from; p <= node.to;) {
            const l = doc.lineAt(p);
            out.push(line('md-quote').range(l.from));
            p = l.to + 1;
          }
          return;
        }
        if (name === 'FencedCode') {
          for (let p = node.from; p <= node.to;) {
            const l = doc.lineAt(p);
            out.push(line('md-block').range(l.from));
            p = l.to + 1;
          }
          return false;
        }

        if (INLINE[name] && node.to > node.from) {
          out.push(mark(INLINE[name]).range(node.from, node.to));
        }

        if (isRaw(node.from)) return;

        if (name === 'HeaderMark') {
          // take the space after the #s with them
          const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          out.push(hide.range(node.from, end));
        } else if (MARKERS.has(name)) {
          if (name === 'URL' && node.node.parent && node.node.parent.name !== 'Link') return;
          // a quote's > takes its following space with it, as a heading's # does
          const end = name === 'QuoteMark' && doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          out.push(hide.range(node.from, end));
        } else if (name === 'ListMark') {
          const text = doc.sliceString(node.from, node.to);
          const parent = node.node.parent;
          const isTask = parent && parent.getChild('Task');
          if (/^[-*+]$/.test(text)) {
            /* A task's dash is dropped entirely — the checkbox is its marker.
               A plain dash becomes a bullet. Ordered numbers stay as they are. */
            if (isTask) {
              const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
              out.push(hide.range(node.from, end));
            } else {
              out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
          }
        } else if (name === 'TaskMarker') {
          const checked = /x/i.test(doc.sliceString(node.from, node.to));
          out.push(Decoration.replace({ widget: new TaskWidget(checked, node.from) }).range(node.from, node.to));
          if (checked) {
            const l = doc.lineAt(node.from);
            if (node.to < l.to) out.push(mark('md-done').range(node.to, l.to));
          }
        } else if (name === 'HorizontalRule') {
          out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
        }
      },
    });
  }

  return Decoration.set(out, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = build(view); }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/* ---- the component ------------------------------------------------------- */

export default function LiveMarkdown({ value, onChange, onBlur, editorRef, autoFocus = false, className = '' }) {
  const host = useRef(null);
  const viewRef = useRef(null);
  /* The latest callbacks, read at event time, so the editor is built once and
     never torn down just because a parent re-rendered with new closures. */
  const cb = useRef({ onChange, onBlur });
  cb.current = { onChange, onBlur };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value || '',
        extensions: [
          history(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          /* The bare language, not markdown(). The helper also wires in HTML,
             CSS and JavaScript support for embedded code — measured, that was
             most of a 500KB jump in the bundle, for highlighting inside fenced
             blocks that this pad does not do. */
          new LanguageSupport(markdownLanguage),
          EditorView.lineWrapping,
          livePreview,
          EditorView.contentAttributes.of({
            'aria-label': 'Notes',
            spellcheck: 'true',
            /* Grammarly plants a floating button inside any editable element it
               finds, which lands on top of the pad. These are the opt-out
               attributes it looks for; all three are needed, because which one
               it reads depends on how old the installed extension is. The
               browser's own spellcheck is left on. */
            'data-gramm': 'false',
            'data-gramm_editor': 'false',
            'data-enable-grammarly': 'false',
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (u.transactions.some((t) => t.annotation(External))) return;
            if (cb.current.onChange) cb.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => { if (cb.current.onBlur) cb.current.onBlur(); },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (editorRef) editorRef.current = view;
    /* On the very first open the editor mounts after the drawer has already
       tried to focus it — the chunk was still arriving — so it focuses itself. */
    let frame = 0;
    if (autoFocus) {
      frame = requestAnimationFrame(() => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      view.destroy();
      viewRef.current = null;
      if (editorRef) editorRef.current = null;
    };
    // built once; `value` is synced by the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Text arriving from outside — the saved notes loading after the editor has
     mounted. Skipped whenever it already matches, which is every keystroke,
     since those come from the editor in the first place. */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if ((value || '') === current) return;
    const next = value || '';
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
      /* Kept out of the undo history. Otherwise the load is the first thing on
         the stack, and Ctrl+Z straight after opening would empty the pad. */
      annotations: [External.of(true), Transaction.addToHistory.of(false)],
      /* The loaded text replaces everything, so there is no old position worth
         mapping — land the cursor at the end, where the next thing is typed. */
      selection: { anchor: next.length },
    });
  }, [value]);

  return <div ref={host} className={`md ${className}`.trim()} />;
}
