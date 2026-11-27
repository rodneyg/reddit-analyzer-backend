const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const { test } = require('node:test')
const { Response } = require('node-fetch')
const { createApp } = require('./index.ts')

const now = Date.parse('2026-11-26T17:00:00Z')
const newest = now / 1000
const cutoff = newest - 86_400

function json(body, options) {
  return new Response(JSON.stringify(body), options)
}

function listing(timestamps, after = null, options) {
  return json({
    data: {
      after,
      children: timestamps.map(created_utc => ({ data: { created_utc, score: 1 } }))
    }
  }, options)
}

async function setup(t, page) {
  const requests = []
  const signals = []
  const app = createApp(async (address, options) => {
    signals.push(options.signal)
    const url = new URL(address)
    if (url.pathname === '/api/v1/access_token') {
      assert.match(options.headers['User-Agent'], /https:\/\/github\.com\/rodneyg\/reddit-analyzer-backend/)
      return json({ access_token: 'mock-token', expires_in: 3600 })
    }
    requests.push(url)
    return page(url, requests.length)
  }, () => now)

  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${server.address().port}/analyze`
  return { request: query => fetch(`${endpoint}?${query}`), requests, signals }
}

test('paginates through the UTC window, includes its boundary and excludes older and future posts', async t => {
  const { request, requests, signals } = await setup(t, (_, page) => page === 1
    ? listing([newest + 1, newest - 60], 't3_next')
    : listing([cutoff, cutoff - 1], 't3_older'))
  const response = await request('subreddit=programming&days=1&limit=2')
  assert.equal(response.status, 200)
  const { heatmapData, bestTimes, sample } = await response.json()
  assert.deepEqual(sample, {
    postCount: 2,
    oldestCreatedUtc: cutoff,
    newestCreatedUtc: newest - 60,
    truncated: false
  })
  assert.equal(heatmapData.length, 2)
  assert.equal(bestTimes.length, 2)
  assert.deepEqual(requests.map(url => [...url.searchParams]), [
    [['limit', '2']],
    [['limit', '2'], ['after', 't3_next']]
  ])
  assert.equal(signals.length, 3)
  assert.ok(signals[0] instanceof AbortSignal)
  assert.ok(signals.every(signal => signal === signals[0]))
})

test('returns 404 when the requested window has no posts', async t => {
  const { request, requests } = await setup(t, () => listing([cutoff - 1], 't3_older'))
  const response = await request('subreddit=programming&days=1')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'No posts found' })
  assert.equal(requests.length, 1)
})

test('caps the listing at ten pages and reports remaining pages as truncated', async t => {
  const { request, requests } = await setup(t, (_, page) =>
    listing([newest - page * 86_400], `t3_${page}`))
  const response = await request('subreddit=programming&days=90')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).sample, {
    postCount: 10,
    oldestCreatedUtc: newest - 10 * 86_400,
    newestCreatedUtc: newest - 86_400,
    truncated: true
  })
  assert.equal(requests.length, 10)
  assert.equal(requests[9].searchParams.get('after'), 't3_9')
})

test('stops pagination when Reddit reports no requests remaining', async t => {
  const { request, requests } = await setup(t, () =>
    listing([newest - 60], 't3_next', { headers: { 'x-ratelimit-remaining': '0' } }))
  const response = await request('subreddit=programming')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sample.truncated, true)
  assert.equal(requests.length, 1)
})

test('passes through a throttling status and retry delay without retrying', async t => {
  const { request, requests } = await setup(t, () =>
    json({}, { status: 429, headers: { 'retry-after': '10' } }))
  const response = await request('subreddit=programming')
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '10')
  assert.deepEqual(await response.json(), { error: 'Reddit rate limit reached' })
  assert.equal(requests.length, 1)
})

test('rejects invalid subreddit, days and limit before contacting Reddit', async t => {
  const { request, signals } = await setup(t, () => assert.fail('unexpected Reddit call'))
  for (const query of [
    'subreddit=foo%2Fbar',
    'subreddit=a&subreddit=b',
    'subreddit=programming&days=0',
    'subreddit=programming&days=1.5',
    'subreddit=programming&limit=101',
    'subreddit=programming&limit=0'
  ]) {
    const response = await request(query)
    assert.equal(response.status, 400, query)
    assert.equal(typeof (await response.json()).error, 'string')
  }
  assert.equal(signals.length, 0)
})

test('rejects empty tokens and invalid expiries without caching them', async t => {
  for (const token of [
    { access_token: '', expires_in: 3600 },
    { access_token: '   ', expires_in: 3600 },
    { access_token: 'mock-token', expires_in: 0 },
    { access_token: 'mock-token', expires_in: Number.NaN }
  ]) {
    const requests = []
    const app = createApp(async address => {
      requests.push(new URL(address))
      return json(token)
    }, () => now)
    const server = app.listen(0, '127.0.0.1')
    t.after(() => server.close())
    await once(server, 'listening')
    const response = await fetch(`http://127.0.0.1:${server.address().port}/analyze?subreddit=programming`)
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: 'Reddit authentication failed' })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].pathname, '/api/v1/access_token')
  }
})

test('clears a cached token after 401 and retries once with a fresh token', async t => {
  const tokenRequests = []
  const listingTokens = []
  let authCount = 0
  let listingCount = 0
  const app = createApp(async (address, options) => {
    const url = new URL(address)
    if (url.pathname === '/api/v1/access_token') {
      tokenRequests.push(url)
      authCount++
      return json({ access_token: `mock-token-${authCount}`, expires_in: 3600 })
    }
    listingTokens.push(options.headers.Authorization)
    listingCount++
    return listingCount === 1
      ? json({}, { status: 401 })
      : listing([newest - 60])
  }, () => now)
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/analyze?subreddit=programming`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sample.postCount, 1)
  assert.equal(authCount, 2)
  assert.deepEqual(listingTokens, ['Bearer mock-token-1', 'Bearer mock-token-2'])
})
