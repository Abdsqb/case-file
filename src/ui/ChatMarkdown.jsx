/**
 * ChatMarkdown.jsx — renders the clerk's replies.
 *
 * The voice asks for sentences, but a plan for a day comes back as a list with
 * bold labels whatever the prompt says, and shown raw that is a column of
 * asterisks. This is the small subset the clerk actually writes — paragraphs,
 * bullet and numbered lists, bold, italic, inline code, and the odd heading —
 * built as React elements rather than HTML, so nothing in a reply is ever
 * parsed as markup. Anything outside the subset falls through as its own text.
 */

const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/

/* Inline: code first so a `*` inside backticks stays literal, then bold, then
   italic. Italic is asterisks only — underscores turn up in course codes and
   tool names, and `HW_6_OS` going half-italic is a worse failure than an
   underscore-italic shown plainly. */
const INLINE = /(`[^`\n]+`)|(\*\*(?=\S)[\s\S]*?\S\*\*)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)/

function inline(text, key = 'i') {
  const out = []
  let rest = text
  let n = 0
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) { out.push(rest); break }
    if (m.index) out.push(rest.slice(0, m.index))
    const tok = m[0]
    const k = `${key}.${n++}`
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>)
    else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>)
    rest = rest.slice(m.index + tok.length)
  }
  return out
}

/* Lines into blocks. A list runs until a blank line or a line that is neither
   an item nor indented under one; an indented line continues the item above. */
function blocks(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let para = null
  let list = null

  const close = () => { para = null; list = null }

  for (const line of lines) {
    if (!line.trim()) { close(); continue }

    const h = HEADING.exec(line)
    if (h) { close(); out.push({ type: 'h', text: h[1] }); continue }

    const b = BULLET.exec(line)
    const o = b ? null : NUMBER.exec(line)
    if (b || o) {
      const type = b ? 'ul' : 'ol'
      if (!list || list.type !== type) {
        para = null
        list = { type, start: o ? Number(o[1]) : 1, items: [] }
        out.push(list)
      }
      list.items.push(b ? b[1] : o[2])
      continue
    }

    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim()
      continue
    }

    list = null
    if (para) para.lines.push(line)
    else { para = { type: 'p', lines: [line] }; out.push(para) }
  }
  return out
}

export default function ChatMarkdown({ text, className }) {
  return (
    <div className={className}>
      {blocks(text).map((b, i) => {
        if (b.type === 'h') return <p key={i} className="md__h">{inline(b.text, `${i}`)}</p>
        if (b.type === 'p') {
          return (
            <p key={i}>
              {b.lines.map((l, j) => (
                <span key={j}>{j ? <br /> : null}{inline(l, `${i}.${j}`)}</span>
              ))}
            </p>
          )
        }
        const List = b.type
        return (
          <List key={i} start={b.type === 'ol' && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, j) => <li key={j}>{inline(it, `${i}.${j}`)}</li>)}
          </List>
        )
      })}
    </div>
  )
}
