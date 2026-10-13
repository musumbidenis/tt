/* Google Groups for class, staff and panel email (bridge 1.4.3: a test only).
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
    var err = new Error((out.error && out.error.message) || ('Google answered ' + res.getResponseCode()));
    err.code = res.getResponseCode(); throw err;
  }
  return out;
}

/** The college's Google customer ID ("C0…"), which every new group needs. Kept in the Script Property GROUPS_CUSTOMER;
 * found from any group this account already belongs to. */
function groupsCustomer_() {
  var p = PropertiesService.getScriptProperties(), have = p.getProperty('GROUPS_CUSTOMER');
  if (have) return have;
  var me = Session.getEffectiveUser().getEmail();
  var q = "member_key_id == '" + me + "' && '" + FORUM + "' in labels";
  var found = groupsApi_('get', CI + 'groups/-/memberships:searchDirectGroups?pageSize=5&query=' + encodeURIComponent(q));
  var first = (found.memberships || [])[0];
  if (!first) throw new Error('This account is not in any Google Group yet, so the college\'s customer ID is unknown. Create any group at groups.google.com as ' + me + ' (you can delete it afterwards) and run this again, or put the customer ID in the Script Property GROUPS_CUSTOMER.');
  var parent = groupsApi_('get', CI + first.group).parent;
  if (!/^customers\//.test(parent || '')) throw new Error('Could not read the customer ID from ' + first.groupKey.id);
  p.setProperty('GROUPS_CUSTOMER', parent);
  return parent;
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
  step('Customer ID', function () { return groupsCustomer_(); });
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
