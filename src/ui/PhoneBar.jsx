/**
 * PhoneBar.jsx — the phone's tab bar, along the bottom where a thumb is.
 *
 * Four screens, and a seat at its right end for the to-do button
 * (TodayWindow.jsx), which keeps both of its jobs there: a tap opens today's
 * list, and a hold fans the corner wheel (CornerWheel.jsx) up out of it with
 * every screen and the notes pad on its arc. Hidden on anything wider than a
 * phone (linear.css), where the sidebar does this.
 */

import { ICONS, NAV, PHONE_TABS } from './nav.js';

const cx = (...c) => c.filter(Boolean).join(' ');

export default function PhoneBar({ current, onGo }) {
  const tabs = PHONE_TABS.map((id) => NAV.find((n) => n.id === id)).filter(Boolean);
  return (
    <nav className="phonebar" aria-label="Screens">
      {tabs.map((n) => {
        const Icon = ICONS[n.id];
        return (
          <a
            key={n.id}
            href={`#${n.id}`}
            className={cx('phonebar__tab', current === n.id && 'is-current')}
            aria-current={current === n.id ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); onGo(n.id); }}
          >
            <Icon className="phonebar__icon" aria-hidden="true" />
            <span className="phonebar__label">{n.short}</span>
          </a>
        );
      })}
      {/* The to-do button sits here; it is TodayWindow's, positioned over this seat. */}
      <span className="phonebar__seat" aria-hidden="true" />
    </nav>
  );
}
