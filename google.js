/* Google sign-in and Drive, for both apps (needs googleClientId in config.js; without it nothing here is used).
 * Students: the app may only see the files it makes in their Drive (drive.file).
 * Staff: the app may also open files students shared with them (drive.readonly), and make their own files.
 * The sign-in lasts about an hour and is kept on this device for that hour (closing the app does not lose it); it is never sent anywhere except to
 * Google and, once when a file is recorded or an account connected, to the college's own server to check it. */
'use strict';

const Google = (() => {
  const cfg = () => window.ATTENDANCE_CONFIG || {};
  const on = () => !!cfg().googleClientId;
  const SCOPES = {
    student: 'openid email https://www.googleapis.com/auth/drive.file',
    staff: 'openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
  };
  const KEY = 'rvnp_google', MAIL = 'rvnp_google_email';
  let tok = null;
  try { tok = JSON.parse(localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || 'null'); } catch { tok = null; }
  const remembered = () => { try { return localStorage.getItem(MAIL) || ''; } catch { return ''; } };

  /* Google's sign-in script, loaded only when needed (it is not kept for offline use). Loading it early, when a screen
   * that may need it opens, lets the sign-in window open straight from the tap (browsers block windows opened later). */
  let gis = null;
  function load() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (!gis) gis = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res(); s.onerror = () => { gis = null; rej(new Error('Google sign-in could not load. Check the internet and try again.')); };
      document.head.appendChild(s);
    });
    return gis;
  }
  const preload = () => { if (on() && navigator.onLine) load().catch(() => {}); };

  const valid = (kind) => !!(tok && tok.kind === kind && tok.exp > Date.now() + 60e3);
  const token = (kind) => (valid(kind) ? tok.token : '');
  const email = () => tok?.email || remembered();

  /** Opens Google's sign-in (call it from a tap). Resolves with { token, email }. */
  async function signIn(kind, { choose = false } = {}) {
    if (!on()) throw new Error('Google sign-in is not set up for this app');
    if (!navigator.onLine) throw new Error('Signing in to Google needs internet');
    await load();
    const got = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: cfg().googleClientId, scope: SCOPES[kind], login_hint: remembered() || undefined,
        hd: cfg().googleDomain || undefined, include_granted_scopes: true,
        callback: (r) => (r.error ? reject(new Error(r.error_description || 'Google sign-in was not completed')) : resolve(r)),
        error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'The Google sign-in window was closed' : 'Google sign-in was blocked. Allow pop-ups for this app and try again.')),
      });
      client.requestAccessToken({ prompt: choose ? 'select_account' : '' });
    });
    if (!google.accounts.oauth2.hasGrantedAllScopes(got, ...SCOPES[kind].split(' ').filter((s) => s.startsWith('https')))) {
      throw new Error('Tick every box Google asks about, so the app can save and share your documents');
    }
    const who = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + got.access_token } })).json();
    const mail = String(who.email || '').toLowerCase();
    if (cfg().googleDomain && !mail.endsWith('@' + cfg().googleDomain)) throw new Error(`Use your college Google account (@${cfg().googleDomain}), not ${mail || 'that one'}.`);
    tok = { kind, token: got.access_token, exp: Date.now() + (Number(got.expires_in) || 3600) * 1000, email: mail };
    try { localStorage.setItem(KEY, JSON.stringify(tok)); localStorage.setItem(MAIL, mail); } catch { /* private window: kept in memory */ }
    return tok;
  }
  function signOut() {
    if (tok && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(tok.token, () => {});
    tok = null;
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); localStorage.removeItem(MAIL); } catch { /* nothing kept */ }
  }

  class NeedSignIn extends Error {}
  async function call(kind, url, opts = {}) {
    const t = token(kind);
    if (!t) throw new NeedSignIn('Sign in to Google first');
    const res = await fetch(url.startsWith('http') ? url : 'https://www.googleapis.com' + url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    if (res.status === 401) { tok = null; try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch { /* */ } throw new NeedSignIn('Your Google sign-in has expired'); }
    return res;
  }
  async function json(kind, url, opts) {
    const res = await call(kind, url, opts);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error?.message || `Google said no (${res.status})`), { status: res.status });
    return out;
  }

  /** A folder the app made (found again by name; the app only ever sees its own). */
  async function folder(kind, name, parent) {
    const q = `name='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
    const found = await json(kind, '/drive/v3/files?fields=files(id)&pageSize=1&q=' + encodeURIComponent(q));
    if (found.files?.[0]) return found.files[0].id;
    const made = await json(kind, '/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) });
    return made.id;
  }
  /** Saves a file in two steps (Google's resumable upload), so a large PDF on a weak network is one request. */
  async function upload(kind, blob, { name, parent, description, mime = 'application/pdf' }) {
    const start = await call(kind, '/upload/drive/v3/files?uploadType=resumable&fields=id,name,md5Checksum,size', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify({ name, mimeType: mime, description, ...(parent ? { parents: [parent] } : {}) }) });
    if (!start.ok) throw new Error(`Google did not start the upload (${start.status})`);
    const where = start.headers.get('Location');
    if (!where) throw new Error('Google did not give an upload address');
    const res = await fetch(where, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.id) throw new Error(out.error?.message || `The upload did not finish (${res.status})`);
    return out;
  }
  /** View-only access for one person, without an email from Google. */
  async function share(kind, fileId, email) {
    await json(kind, `/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }) });
  }
  const meta = (kind, fileId) => json(kind, `/drive/v3/files/${fileId}?fields=id,name,md5Checksum,size,modifiedTime,owners(emailAddress)&supportsAllDrives=true`);
  async function download(kind, fileId) {
    const res = await call(kind, `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
    if (!res.ok) throw Object.assign(new Error(res.status === 404 || res.status === 403 ? 'not-shared' : `Google said no (${res.status})`), { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }

  return { on, preload, signIn, signOut, token, email, NeedSignIn, folder, upload, share, meta, download };
})();
