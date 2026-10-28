/* Three faces, one job each, bundled rather than fetched from Google: no
   request to a third party on every cold start, the type survives being
   offline, and the files are hashed assets the server caches for good. Their
   @font-face rules land in the stylesheet in <head>, so they are declared
   before first paint — a swap at metric size is unmissable.
     Geist             the UI: headings, labels, body (variable, 100-900)
     Geist Mono        everything that is data: counts, times, ids, status
     Instrument Serif  the one emphasised word in a title, italic */
import "@fontsource-variable/geist";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./ui/SignIn.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);

// production only — a service worker in dev would fight with Vite's HMR
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch(err => console.error("Service worker registration failed", err));
  });
}
