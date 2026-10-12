/* Where both apps (trainer and student) find the server.
 *   serverUrl        the Cloudflare Worker address, like https://rvnp-attendance.<name>.workers.dev
 *                    (README → "Set up the database"). Used whenever it is filled in.
 *   sheetsUrl        the older Google Apps Script address (ends in /exec), used until serverUrl is set.
 *   vapidPublicKey   lets students switch on notifications about their evidence. Make the pair once with
 *                    `npx web-push generate-vapid-keys`: the public key goes here, the private one into
 *                    the Worker (README → "Notifications for students"). Leave it empty and the app
 *                    simply does not offer notifications.
 *   googleClientId   the app's Google sign-in ID (Google Cloud → Credentials → OAuth client ID, Web application).
 *                    Filled in: students save their POE evidence in their own college Google Drive and share it
 *                    with their trainer; staff connect Google to open it. Empty: evidence goes through the Drive bridge.
 *   googleDomain     only accounts at this domain may sign in (the college's Google Workspace).
 * None of these is secret: without signing in, anyone can only read class names, register a student
 * phone and send check-ins that the server verifies. Staff actions need a staff code and PIN. */
window.ATTENDANCE_CONFIG = {
  serverUrl: 'https://rvnp-attendance.ictpoe.workers.dev/',
  sheetsUrl: 'https://script.google.com/macros/s/AKfycbw3bSI2h4GrfV2BBmZOqDkyioa4tYZz3ND_PL-0JurcQKneg9TNBwbuLMPBh3qqIKOxTA/exec',
  vapidPublicKey: '',
  googleClientId: '945611933983-grt6lrqgnovsbe52rec7bd9tdmt8j1rp.apps.googleusercontent.com',
  googleDomain: 'rvnp.ac.ke',
};
