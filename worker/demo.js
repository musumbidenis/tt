/* The demo copy: the same server (worker.js) and the same apps, at their own address with their own database.
 * One Worker serves both: /exec is the server, /config.js points the apps at it, and every other path is the
 * apps' files (wrangler.demo.toml → [assets]). Being a separate address, the demo apps keep their own storage on
 * a device, apart from the real ones. Nothing here changes how the real app works. */
import server from './worker.js';

const CONFIG = (origin, vapid, env) => `/* The demo copy (served by worker/demo.js, not the config.js file). */
window.ATTENDANCE_CONFIG = { serverUrl: ${JSON.stringify(origin + '/exec')}, sheetsUrl: '', vapidPublicKey: ${JSON.stringify(vapid || '')}, googleClientId: ${JSON.stringify(env.GOOGLE_CLIENT_ID || '')}, googleDomain: ${JSON.stringify(env.GOOGLE_DOMAIN || '')}, demo: true };
document.addEventListener('DOMContentLoaded', () => {
  document.title = 'Demo · ' + document.title;
  const t = document.querySelector('.topbar .brand strong');
  if (t) t.insertAdjacentHTML('beforeend', ' <span title="Practice copy with invented data" style="display:inline-block;width:auto;margin-left:.3em;background:#f59e0b;color:#1f2937;border-radius:999px;padding:.05em .55em;font-size:.7em;vertical-align:middle">DEMO</span>');
});
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/exec') return server.fetch(request, env, ctx);
    if (url.pathname === '/config.js') {
      return new Response(CONFIG(url.origin, env.VAPID_PUBLIC_KEY, env), { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    if (url.pathname === '/student') return env.ASSETS.fetch(new Request(new URL('/student.html', url), request));
    return env.ASSETS.fetch(request);
  },
};
