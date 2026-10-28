/* The clock the server reads dates by.
 *
 * Due dates, "today", class times and the clerk's sense of the day are all
 * worked out in the server's local time, the same way the browser works them
 * out — a deadline is a day on your calendar, not an instant in UTC. On your
 * PC that is simply your time zone. Hosted, the machine runs in UTC and the
 * platform reserves the TZ variable, so the zone is given as APP_TIMEZONE
 * (e.g. America/New_York) and set here.
 *
 * Its own module, imported first by app.js: ES modules run their imports
 * before their own body, so setting it anywhere later would be too late for
 * anything that reads a date while loading. */
const zone = (process.env.APP_TIMEZONE || '').trim();
if (zone) process.env.TZ = zone;
