const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.join(__dirname, '..');
const blocklist = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'blocklist.json'), 'utf8'));
const scriptPath = path.join(repositoryRoot, 'Bilibili隐藏短视频.user.js');
const engine = require(scriptPath);

test('publishes a deduplicated MEME and CHEEMS low-quality meme list', () => {
  assert.equal(blocklist.description, '低质迷因');
  assert.deepEqual(blocklist.queries, ['MEME', 'CHEEMS']);
  assert.equal(blocklist.count, 2000);
  assert.equal(blocklist.accounts.length, blocklist.count);
  assert.equal(blocklist.uids.length, blocklist.count);
  assert.equal(new Set(blocklist.uids).size, blocklist.count);
  assert.deepEqual(blocklist.accounts.map((account) => account.uid), blocklist.uids);

  const queryCounts = new Map(blocklist.query_stats.map((item) => [item.query, item.unique_accounts]));
  assert.equal(queryCounts.get('MEME'), 1000);
  assert.equal(queryCounts.get('CHEEMS'), 1000);

  for (const account of blocklist.accounts) {
    assert.equal(account.reason, '低质迷因');
    assert.match(account.uid, /^\d+$/);
    assert.equal(account.url, `https://space.bilibili.com/${account.uid}`);
    assert.ok(account.matched_queries.some((query) => ['MEME', 'CHEEMS'].includes(query)));
  }
});

test('records the CHEEMS browser crawl provenance', () => {
  const cheems = blocklist.query_stats.find((item) => item.query === 'CHEEMS');
  assert.equal(cheems.method, 'logged-in browser DOM crawl');
  assert.equal(cheems.pages_fetched, 28);
  assert.equal(cheems.raw_results_fetched, 1000);
});

test('userscript exposes the low-quality meme description and preserves list reasons', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /^\/\/ @version\s+7\.1$/m);
  assert.match(source, /^\/\/ @description\s+低质迷因$/m);

  const parsed = engine.parseLowQualityDb(JSON.stringify(blocklist), 'repository');
  assert.equal(parsed.length, blocklist.count);
  assert.equal(parsed[0].tip, '低质迷因');
});
