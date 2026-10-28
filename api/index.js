/* The app on Vercel. Every /api/* request is rewritten here (vercel.json),
 * and Express routes it exactly as it does on your PC — the routes live in
 * server/app.js and are shared. The built frontend is not served from here:
 * Vercel serves dist/ from its CDN. */
import app from '../server/app.js';

export default app;
