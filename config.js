/* Where the app finds the Google Sheet: the Apps Script web app URL (ends in /exec).
 * Both apps use it. It is not secret: without signing in, anyone can only read class names,
 * register a student phone and send check-ins that the Sheet verifies. Staff actions need a
 * staff code and PIN. */
window.ATTENDANCE_CONFIG = {
  sheetsUrl: 'https://script.google.com/macros/s/AKfycbw3bSI2h4GrfV2BBmZOqDkyioa4tYZz3ND_PL-0JurcQKneg9TNBwbuLMPBh3qqIKOxTA/exec',
};
