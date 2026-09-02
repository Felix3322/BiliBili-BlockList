const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.join(__dirname, '..');
const authorBlocklist = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'author-blacklist.json'), 'utf8'));
const engine = require(path.join(repositoryRoot, 'Bilibili隐藏短视频.user.js'));

test('publishes the author blacklist as exact-name rules', () => {
  assert.equal(authorBlocklist.source, 'https://account.bilibili.com/account/blacklist');
  assert.equal(authorBlocklist.description, '作者本人的黑名单');
  assert.equal(authorBlocklist.category_note, '主要是新闻融媒体');
  assert.equal(authorBlocklist.pages_fetched, 44);
  assert.equal(authorBlocklist.raw_results_fetched, 879);
  assert.equal(authorBlocklist.count, 875);
  assert.equal(authorBlocklist.accounts.length, authorBlocklist.count);
  assert.equal(authorBlocklist.names.length, authorBlocklist.count);
  assert.equal(new Set(authorBlocklist.names).size, authorBlocklist.count);
  assert.deepEqual(authorBlocklist.accounts.map((account) => account.name), authorBlocklist.names);

  for (const account of authorBlocklist.accounts) {
    assert.ok(account.name.trim());
    assert.equal(account.reason, '作者本人的黑名单');
    assert.equal(account.uid, undefined);
  }
});

test('userscript parses author blacklist entries as exact UP-name rules', () => {
  const parsed = engine.parseLowQualityDb(JSON.stringify(authorBlocklist), 'author');
  assert.equal(parsed.length, authorBlocklist.count);
  assert.equal(parsed[0].type, 'upName');
  assert.equal(parsed[0].tip, '作者本人的黑名单');
});

test('repository subscription includes both built-in list URLs while remaining opt-in', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'Bilibili隐藏短视频.user.js'), 'utf8');
  assert.match(source, /const DEFAULT_BLOCKLIST_URLS = \[DEFAULT_BLOCKLIST_URL, AUTHOR_BLOCKLIST_URL\]/);
  assert.match(source, /loadBool\(KEY\.repoSubscriptionEnabled, false\)/);
});
