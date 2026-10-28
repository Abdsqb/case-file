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
 */

import { useEffect, useRef, useState } from 'react';

import { SIGNED_OUT, getSession, login } from '../lib/api.js';

export default function AuthGate({ children }) {
  /* 'checking' until the server answers, then 'in' or 'out'. A server that
     cannot be reached is let through: the app has its own unreachable states,
     and a sign-in box in front of a dead server would only hide the real fault. */
  const [state, setState] = useState('checking');

  useEffect(() => {
    let alive = true;
    getSession()
      .then((s) => { if (alive) setState(!s || !s.required || s.authenticated ? 'in' : 'out'); })
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
      onIn();
    } catch (err) {
      const reason = err && err.body && typeof err.body.error === 'string' ? err.body.error : '';
      setError(reason || 'could not sign in. check the connection and try again.');
      setPassword('');
      setBusy(false);
      requestAnimationFrame(() => inputRef.current && inputRef.current.focus());
    }
  };

  return (
    <main className="signin">
      <form className="card signin__card" onSubmit={submit}>
        <div className="signin__head">
          <img className="signin__mark" src="/favicon.svg" alt="" width="36" height="36" />
          <div>
            <h1 className="signin__name">Case</h1>
            <p className="signin__sub">Sign in to open your archive.</p>
          </div>
        </div>

        <label className="signin__label" htmlFor="signin-password">Password</label>
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

        <button type="submit" className="signin__go" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
