/**
 * SignIn.jsx — the one screen in front of the hosted app.
 *
 * AuthGate asks the server first whether this install has a password at all.
 * On your PC it does not, and the app renders straight away exactly as it
 * always has. Hosted, the app stays unmounted until this browser holds a
 * session, so nothing in it fires a request that would only be refused.
 *
 * Any 401 later — the session ran out, or every device was signed out by
 * changing the secret — puts this screen back up (lib/api.js raises it).
 *
 * It is laid out like the case structure card: the same title bar, with the
 * name, its measurements in monospace and a state pill; a body; and a foot
 * along the bottom. Behind it, blurred, is the dashboard as it looks on the
 * app's built-in sample data — never yours, because this screen is what
 * anyone with the address can see.
 *
 * What is behind it depends on whether this device has signed in before:
 *   never  — Turquoise and Glass Current, baked into one picture
 *            (public/signin-backdrop*.webp), the house look.
 *   before — your own accent and background, live: the same Streak that runs
 *            behind the app, with the dashboard's layout (public/
 *            signin-layout*.webp, sample data on black) screened over it.
 */

import { useEffect, useRef, useState } from 'react';

import { SIGNED_OUT, getSession, login } from '../lib/api.js';
import Streak from './Streak.jsx';

/* Remembered per device, like the accent itself: once you have signed in
   here, the sign-in screen dresses in your own settings next time. */
const SEEN = 'casefile.signedInHere';
const signedInHere = () => { try { return localStorage.getItem(SEEN) === '1'; } catch { return false; } };
const rememberSignedIn = () => { try { localStorage.setItem(SEEN, '1'); } catch { /* private mode */ } };

export default function AuthGate({ children }) {
  /* 'checking' until the server answers, then 'in' or 'out'. A server that
     cannot be reached is let through: the app has its own unreachable states,
     and a sign-in box in front of a dead server would only hide the real fault. */
  const [state, setState] = useState('checking');

  useEffect(() => {
    let alive = true;
    getSession()
      .then((s) => {
        if (s && s.required && s.authenticated) rememberSignedIn();
        if (alive) setState(!s || !s.required || s.authenticated ? 'in' : 'out');
      })
      .catch(() => { if (alive) setState('in'); });
    const out = () => setState('out');
    window.addEventListener(SIGNED_OUT, out);
    return () => { alive = false; window.removeEventListener(SIGNED_OUT, out); };
  }, []);

  if (state === 'checking') return null;
  if (state === 'out') return <SignIn onIn={() => setState('in')} />;
  return children;
}

function SignIn({ onIn }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
      rememberSignedIn();
      onIn();
    } catch (err) {
      const reason = err && err.body && typeof err.body.error === 'string' ? err.body.error : '';
      setError(reason || 'could not sign in. check the connection and try again.');
      setPassword('');
      setBusy(false);
      requestAnimationFrame(() => inputRef.current && inputRef.current.focus());
    }
  };

  const pill = busy
    ? { tone: 'idle', text: 'checking' }
    : error
      ? { tone: 'overdue', text: 'refused' }
      : { tone: 'idle', text: 'locked' };

  const [own] = useState(signedInHere);

  return (
    <main className="signin" data-accent={own ? undefined : 'turquoise'}>
      {own ? (
        <>
          <div className="signin__live" aria-hidden="true">
            <Streak view="dashboard" />
          </div>
          <div className="signin__backdrop signin__backdrop--layout" aria-hidden="true">
            <picture>
              <source media="(max-width: 640px)" srcSet="/signin-layout-phone.webp" />
              <img src="/signin-layout.webp" alt="" />
            </picture>
          </div>
        </>
      ) : (
        <div className="signin__backdrop" aria-hidden="true">
          <picture>
            <source media="(max-width: 640px)" srcSet="/signin-backdrop-phone.webp" />
            <img src="/signin-backdrop.webp" alt="" />
          </picture>
        </div>
      )}

      <form className="signin__panel" onSubmit={submit}>
        <header className="flow__bar">
          <span className="flow__name">Case</span>
          <span className="flow__count">
            sign in
            <span className="flow__sep">/</span>
            your archive
          </span>
          <span className={`statpill statpill--${pill.tone} flow__state`}>{pill.text}</span>
        </header>

        <div className="signin__body">
          <label className="signin__label" htmlFor="signin-password">password</label>
          <input
            ref={inputRef}
            id="signin-password"
            className="signin__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <p className="signin__error" role="alert">{error}</p>
        </div>

        <div className="card__foot signin__foot">
          <span className="nowrap">Stays signed in on this device</span>
          <button type="submit" className="pill pill--active" disabled={busy || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </main>
  );
}
