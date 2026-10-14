/* Google Groups for class, staff and panel email, and the app's messages (bridge 1.5.0).
 *
 * mailAndGroups_(started), at the end of every bridge run: asks the Worker (groupsJob) for the messages waiting to be
 * emailed and the groups whose members changed; sends each message from this account as a hidden copy (Bcc) to the groups
 * and people it is for, with Reply-To the sender, so a reply never goes to a whole class; makes any group that does not
 * exist yet and adds or removes members (only members this script added are ever removed); reports back (groupsDone).
 *
 * The groups are made and kept by this script through the Cloud Identity Groups API, as the account the script runs as.
 * That account needs no admin role: it can create groups (as it can at groups.google.com) and, as their owner, add
 * and remove members. Needs the Cloud Identity API (and, for the posting settings, the Groups Settings API) switched on
 * in the script's Google Cloud project (TECHNICAL.md 4.6).
 *
 * testGroups(): run it once from the editor. It makes ark-test@<domain>, adds and removes one member, sends one email
 * to the group, deletes the group, and logs what worked. Nothing else is touched.
 */
var CI = 'https://cloudidentity.googleapis.com/v1/';
var FORUM = 'cloudidentity.googleapis.com/groups.discussion_forum';

function groupsApi_(method, url, body) {
  var res = UrlFetchApp.fetch(url, { method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: body ? JSON.stringify(body) : undefined });
  var out = {}; try { out = JSON.parse(res.getContentText() || '{}'); } catch (e) { out = {}; }
  if (res.getResponseCode() >= 300) {
    // Google puts the reason for "invalid argument" in error.details (field violations, reasons).
    var why = ((out.error && out.error.details) || []).map(function (d) {
      return (d.fieldViolations || []).map(function (v) { return v.field + ': ' + v.description; }).concat(d.reason ? [d.reason] : [], d.detail ? [d.detail] : []).join('; ');
    }).filter(String).join(' | ');
    var err = new Error(((out.error && out.error.message) || ('Google answered ' + res.getResponseCode())) + (why ? ' (' + why + ')' : ''));
    err.code = res.getResponseCode(); throw err;
  }
  return out;
}

/** The college's Google customer ID ("customers/C0…"), which every new group needs. Kept in the Script Property
 * GROUPS_CUSTOMER once known. Tried in turn: the account's own directory entry, then any group it belongs to;
 * or a group made by hand (ark-probe). tried collects what each way answered. */
function groupsCustomer_(tried) {
  var p = PropertiesService.getScriptProperties(), have = p.getProperty('GROUPS_CUSTOMER');
  if (have) return have;
  tried = tried || [];
  var me = Session.getEffectiveUser().getEmail(), found = '';
  var ways = [
    ['directory entry', function () {
      var u = groupsApi_('get', 'https://admin.googleapis.com/admin/directory/v1/users/' + encodeURIComponent(me) + '?viewType=domain_public');
      return u.customerId ? 'customers/' + u.customerId : '';
    }],
    ['ark-probe group', function () {
      // A group made by hand at groups.google.com (GROUPS_PROBE, default ark-probe@<domain>): its record names the customer.
      var probe = p.getProperty('GROUPS_PROBE') || ('ark-probe@' + me.split('@')[1]);
      var g = groupByEmail_(probe);
      return g ? groupsApi_('get', CI + g).parent || '' : '';
    }],
    ['groups this account is in', function () {
      var q = "member_key_id == '" + me + "' && '" + FORUM + "' in labels";
      var first = (groupsApi_('get', CI + 'groups/-/memberships:searchDirectGroups?query=' + encodeURIComponent(q)).memberships || [])[0];
      return first ? groupsApi_('get', CI + first.group).parent || '' : '';
    }],
  ];
  for (var i = 0; i < ways.length && !found; i++) {
    try { found = ways[i][1](); tried.push(ways[i][0] + ': ' + (found || 'nothing')); }
    catch (e) { tried.push(ways[i][0] + ': ' + e.message); }
  }
  if (/^customers\/C/.test(found)) { p.setProperty('GROUPS_CUSTOMER', found); return found; }
  throw new Error('Could not find the college customer ID. Create the group ark-probe@' + me.split('@')[1] + ' at groups.google.com as ' + me + ' and run this again, or put the ID (customers/C0…) in the Script Property GROUPS_CUSTOMER.');
}

function groupByEmail_(email) {
  try { return groupsApi_('get', CI + 'groups:lookup?groupKey.id=' + encodeURIComponent(email)).name; }
  catch (e) { if (e.code === 404 || e.code === 403) return ''; throw e; }
}

function testGroups() {
  var me = Session.getEffectiveUser().getEmail(), domain = me.split('@')[1];
  var p = PropertiesService.getScriptProperties();
  var email = 'ark-test@' + domain, member = p.getProperty('GROUPS_TEST_MEMBER') || ('musumbidenis@' + domain);
  var log = [], ok = true, name = '', membership = '';
  // opt.optional: a failure is noted but the test carries on; opt.always: runs even after a failure (tidying up).
  function step(what, fn, opt) {
    opt = opt || {};
    if (!ok && !opt.always) { log.push('– ' + what + ': skipped'); return; }
    try { var r = fn(); log.push('✓ ' + what + (r ? ': ' + r : '')); }
    catch (e) { if (!opt.optional) ok = false; log.push('✗ ' + what + ': ' + e.message); }
  }
  var tried = [];
  step('Customer ID', function () {
    try { var c = groupsCustomer_(tried); return c + (tried.length ? ' [' + tried.join(' · ') + ']' : ''); }
    catch (e) { throw new Error(e.message + ' [' + tried.join(' · ') + ']'); }
  });
  step('Create ' + email, function () {
    name = groupByEmail_(email);
    if (name) return 'it was already there (' + name + ')';
    groupsApi_('post', CI + 'groups?initialGroupConfig=WITH_INITIAL_OWNER', { parent: groupsCustomer_(), groupKey: { id: email },
      displayName: 'The ARK test', description: 'Made by The ARK to check it can manage groups. Deleted straight away.', labels: { 'cloudidentity.googleapis.com/groups.discussion_forum': '' } });
    for (var i = 0; i < 10 && !name; i++) { Utilities.sleep(1500); name = groupByEmail_(email); }
    if (!name) throw new Error('Google accepted it but the group has not appeared yet. Run this again in a minute.');
    return name;
  });
  step('Posting settings (owners only, members hidden)', function () {
    groupsApi_('patch', 'https://www.googleapis.com/groups/v1/groups/' + encodeURIComponent(email) + '?alt=json', {
      whoCanPostMessage: 'ALL_MANAGERS_CAN_POST', whoCanViewMembership: 'ALL_MANAGERS_CAN_VIEW', whoCanJoin: 'INVITED_CAN_JOIN',
      allowExternalMembers: 'false', messageModerationLevel: 'MODERATE_NONE', spamModerationLevel: 'ALLOW' });
    return 'set';
  }, { optional: true });
  step('Add ' + member, function () {
    groupsApi_('post', CI + name + '/memberships', { preferredMemberKey: { id: member }, roles: [{ name: 'MEMBER' }] });
    membership = groupsApi_('get', CI + name + '/memberships:lookup?memberKey.id=' + encodeURIComponent(member)).name;
    return membership;
  });
  step('List members', function () {
    var list = groupsApi_('get', CI + name + '/memberships?view=BASIC').memberships || [];
    return list.map(function (m) { return m.preferredMemberKey.id + ' (' + m.roles.map(function (r) { return r.name; }).join('/') + ')'; }).join(', ');
  });
  step('Send one email to the group', function () {
    MailApp.sendEmail({ to: email, name: 'The ARK', subject: 'The ARK: group email test',
      body: 'This is a test from The ARK. It checks that the app can email a class group. You can ignore it.' });
    Utilities.sleep(30000);   // let Google deliver it before the group goes
    return 'sent (' + MailApp.getRemainingDailyQuota() + ' recipients left today)';
  }, { optional: true });
  step('Remove ' + member, function () { if (!membership) return 'not added'; groupsApi_('delete', CI + membership); return 'removed'; }, { always: true });
  step('Delete ' + email, function () { if (name) groupsApi_('delete', CI + name); return name ? 'deleted' : 'nothing to delete'; }, { always: true });
  var summary = (ok ? 'Groups work. ' : 'Groups test stopped. ') + '\n' + log.join('\n');
  p.setProperty('GROUPS_TEST_RESULT', new Date().toISOString() + '\n' + summary);
  Logger.log(summary);
  return summary;
}

/* ---------- the app's groups and messages ---------- */
function groupMembers_(name) {
  var out = [], token = '';
  do {
    var page = groupsApi_('get', CI + name + '/memberships?view=BASIC&pageSize=200' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (page.memberships || []).forEach(function (m) { if (m.preferredMemberKey && m.preferredMemberKey.id) out.push({ email: m.preferredMemberKey.id.toLowerCase(), name: m.name, owner: (m.roles || []).some(function (r) { return r.name === 'OWNER'; }) }); });
    token = page.nextPageToken || '';
  } while (token);
  return out;
}
function ensureGroup_(g) {
  var name = g.groupName || groupByEmail_(g.email);
  if (name) return name;
  groupsApi_('post', CI + 'groups?initialGroupConfig=WITH_INITIAL_OWNER', { parent: groupsCustomer_(), groupKey: { id: g.email },
    displayName: g.name, description: g.description || 'Kept by The ARK.', labels: { 'cloudidentity.googleapis.com/groups.discussion_forum': '' } });
  for (var i = 0; i < 10 && !name; i++) { Utilities.sleep(1500); name = groupByEmail_(g.email); }
  if (!name) throw new Error('Google has not finished making ' + g.email + ' yet');
  return name;
}
/** Returns true when work is left over for the next run. */
function mailAndGroups_(started) {
  var job = callWorker_('groupsJob', {}), out = { mail: [], groups: [] }, me = Session.getEffectiveUser().getEmail(), left = false;
  (job.mail || []).forEach(function (m) {
    if (Date.now() - started > TIME_BUDGET_MS) { left = true; return; }
    try {
      var bcc = (m.bcc || []).filter(Boolean);
      if (!bcc.length) throw new Error('nobody to send it to');
      if (MailApp.getRemainingDailyQuota() < bcc.length) { left = true; out.mail.push({ id: m.id, ok: false, error: 'the daily email allowance is used up; it goes tomorrow', later: true }); return; }
      MailApp.sendEmail({ to: me, bcc: bcc.join(','), name: 'The ARK', replyTo: m.replyTo || me, subject: m.subject, body: m.text, htmlBody: m.html });
      out.mail.push({ id: m.id, ok: true });
    } catch (e) { out.mail.push({ id: m.id, ok: false, error: String(e.message || e) }); }
  });
  (job.groups || []).forEach(function (g) {
    if (Date.now() - started > TIME_BUDGET_MS) { left = true; return; }
    var rep = { key: g.key, email: g.email, added: [], removed: [], failed: [] };
    try {
      rep.groupName = ensureGroup_(g);
      var have = groupMembers_(rep.groupName), haveSet = {};
      have.forEach(function (m) { haveSet[m.email] = m; });
      var want = {}; (g.want || []).forEach(function (e) { want[String(e).toLowerCase()] = true; });
      Object.keys(want).forEach(function (e) {
        if (haveSet[e]) return;
        try { groupsApi_('post', CI + rep.groupName + '/memberships', { preferredMemberKey: { id: e }, roles: [{ name: 'MEMBER' }] }); rep.added.push(e); }
        catch (err) { rep.failed.push(e + ': ' + err.message); }
      });
      // Only those this script added, and no longer wanted, are taken out: anyone added by hand stays.
      (g.added || []).forEach(function (e) {
        e = String(e).toLowerCase();
        if (want[e] || !haveSet[e] || haveSet[e].owner) return;
        try { groupsApi_('delete', CI + haveSet[e].name); rep.removed.push(e); }
        catch (err) { rep.failed.push(e + ': ' + err.message); }
      });
    } catch (e) { rep.error = String(e.message || e); }
    out.groups.push(rep);
  });
  if (out.mail.length || out.groups.length) callWorker_('groupsDone', out);
  return left || !!job.more;
}
