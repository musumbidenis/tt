/* Where both apps (trainer and student) find the server.
 *   serverUrl  the Cloudflare Worker address, like https://rvnp-attendance.<name>.workers.dev
 *              (README → "Set up the database"). Used whenever it is filled in.
 *   sheetsUrl  the older Google Apps Script address (ends in /exec), used until serverUrl is set.
 * Neither is secret: without signing in, anyone can only read class names, register a student
 * phone and send check-ins that the server verifies. Staff actions need a staff code and PIN. */
window.ATTENDANCE_CONFIG = {
  serverUrl: 'https://rvnp-attendance.ictpoe.workers.dev/',
  sheetsUrl: 'https://script.google.com/macros/s/AKfycbw3bSI2h4GrfV2BBmZOqDkyioa4tYZz3ND_PL-0JurcQKneg9TNBwbuLMPBh3qqIKOxTA/exec',
};
