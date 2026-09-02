const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'Bilibili隐藏短视频.user.js');
const engine = require(scriptPath);

function loc(url) {
  const value = new URL(url);
  return { hostname: value.hostname, pathname: value.pathname };
}

test('routes representative Bilibili page families to one primary adapter', () => {
  const cases = [
    ['https://www.bilibili.com/', 'feed'],
    ['https://search.bilibili.com/all?keyword=MEME', 'feed'],
    ['https://www.bilibili.com/c/tech/', 'feed'],
    ['https://www.bilibili.com/v/popular/all', 'popular'],
    ['https://www.bilibili.com/video/BV1dkKb6ZEwS', 'video-page'],
    ['https://t.bilibili.com/', 'dynamic'],
    ['https://www.bilibili.com/watchlater/list', 'watchlater'],
    ['https://www.bilibili.com/history', 'history'],
    ['https://space.bilibili.com/123/favlist', 'favorites'],
    ['https://space.bilibili.com/123/upload/video', 'space-upload'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(engine.DOM_ADAPTERS.find((item) => item.matches(loc(url))).id, expected, url);
  }
});

test('extracts BV ids from video and watch-later URLs', () => {
  assert.equal(engine.extractBvid('https://www.bilibili.com/video/BV1abcDEF123/'), 'BV1abcDEF123');
  assert.equal(engine.extractBvid('https://www.bilibili.com/list/watchlater/?bvid=BV1oxv6B8Ege&oid=1'), 'BV1oxv6B8Ege');
  assert.equal(engine.extractBvid('https://member.bilibili.com/platform/upload/video/frame'), '');
});

test('extracts UID only from stable space links or numeric values', () => {
  assert.equal(engine.extractUid('https://space.bilibili.com/3546756514056252?spm_id_from=333'), '3546756514056252');
  assert.equal(engine.extractUid('11706381'), '11706381');
  assert.equal(engine.extractUid('not-a-uid'), '');
});

test('uses total duration when progress and total are both present', () => {
  assert.equal(engine.convertDurationToSeconds('00:13/12:21'), 741);
  assert.equal(engine.convertDurationToSeconds('直播回放 06:25:29'), 23129);
  assert.equal(engine.convertDurationToSeconds('已看完'), 0);
});

test('parses repository, object and plain-text subscription formats', () => {
  const fromRepo = engine.parseLowQualityDb(JSON.stringify({ uids: ['123456', '234567'] }), 'repo');
  assert.deepEqual(fromRepo.map((item) => item.value), ['123456', '234567']);
  const fromAccounts = engine.parseLowQualityDb(JSON.stringify({ accounts: [{ uid: '345678', reason: 'test' }] }), 'custom');
  assert.equal(fromAccounts[0].type, 'uid');
  assert.equal(fromAccounts[0].tip, 'test');
  const fromText = engine.parseLowQualityDb('# comment\nuid:456789|manual\nSomeUP', 'text');
  assert.deepEqual(fromText.map(({ type, value }) => ({ type, value })), [
    { type: 'uid', value: '456789' },
    { type: 'upName', value: 'SomeUP' },
  ]);
});

test('repository network loading is opt-in in source defaults', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /loadBool\(KEY\.repoSubscriptionEnabled, false\)/);
  assert.match(source, /默认关闭且不会发起网络请求/);
  assert.doesNotMatch(source, /lowQualityDbUrls\.push\(DEFAULT_BLOCKLIST_URL\)/);
});

test('normalizes multiple subscription URLs and ignores invalid values', () => {
  assert.deepEqual(engine.normalizeSubscriptionUrls([
    ' https://example.com/a.json ',
    'not-a-url',
    'http://example.com/b.txt',
    'https://example.com/a.json',
    'ftp://example.com/list.txt',
  ]), [
    'https://example.com/a.json',
    'http://example.com/b.txt',
  ]);
});

test('keeps cross-source rules in cache and deduplicates the active merged view', () => {
  const sharedA = { type: 'uid', value: '123456', source: 'https://a.example/list.json' };
  const sharedB = { type: 'uid', value: '123456', source: 'https://b.example/list.json' };
  assert.equal(engine.dedupeLowQualityAccounts([sharedA, sharedB], true).length, 2);
  assert.equal(engine.dedupeLowQualityAccounts([sharedA, sharedB]).length, 1);
});

test('updates multiple subscriptions in parallel with failure isolation', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /^\/\/ @version\s+7\.2$/m);
  assert.match(source, /^\/\/ @description\s+B站多页面视频卡片检测引擎/m);
  assert.doesNotMatch(source, /^\/\/ @description\s+低质迷因$/m);
  assert.match(source, /Promise\.allSettled\(activeUrls\.map/);
  assert.match(source, /失败来源继续使用已有缓存/);
  assert.match(source, /每行一个 HTTP\/HTTPS 地址/);
});
