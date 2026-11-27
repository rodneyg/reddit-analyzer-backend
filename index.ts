import express, { Request, Response } from 'express'
import cors from 'cors'
import fetch, { Response as FetchResponse } from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

const {
  REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET,
  REDDIT_USERNAME,
  REDDIT_PASSWORD
} = process.env

const MAX_PAGES = 10
const ANALYSIS_TIMEOUT_MS = 40_000
const SECONDS_PER_DAY = 86_400
const USER_AGENT = 'reddit-analyzer-backend/1.0 (https://github.com/rodneyg/reddit-analyzer-backend)'

type RedditPost = {
  created_utc: number
  score?: number
  num_comments?: number
}

type Listing = {
  data: {
    after: string | null
    children: Array<{ data: RedditPost }>
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function upstreamError(response: FetchResponse, res: Response) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) res.set('Retry-After', retryAfter)
  res.status(response.status).json({ error: response.status === 429 ? 'Reddit rate limit reached' : 'Reddit request failed' })
}

export function createApp(fetchReddit = fetch, now = Date.now) {
  const app = express()
  app.use(cors())
  app.use(express.json())

  let accessToken: string | null = null
  let tokenExpiry = 0

  app.get('/analyze', async (req: Request, res: Response) => {
    const { subreddit, days = '30', limit = '100' } = req.query
    const windowDays = positiveInteger(days)
    const pageSize = positiveInteger(limit)

    if (typeof subreddit !== 'string' || !/^[a-zA-Z0-9_]{1,21}$/.test(subreddit)) {
      res.status(400).json({ error: subreddit ? 'Invalid subreddit name' : 'Subreddit is required' })
      return
    }
    if (windowDays === null) {
      res.status(400).json({ error: 'Days must be a positive whole number' })
      return
    }
    if (pageSize === null || pageSize > 100) {
      res.status(400).json({ error: 'Limit must be a whole number from 1 to 100' })
      return
    }

    const startedAt = now()
    const newestAllowed = startedAt / 1000
    const cutoff = newestAllowed - windowDays * SECONDS_PER_DAY
    const signal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS)

    try {
      if (!accessToken || startedAt >= tokenExpiry - 60_000) {
        const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')
        const tokenResponse = await fetchReddit('https://www.reddit.com/api/v1/access_token', {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT
          },
          body: new URLSearchParams({
            grant_type: 'password',
            username: REDDIT_USERNAME!,
            password: REDDIT_PASSWORD!
          })
        })
        if (!tokenResponse.ok) {
          upstreamError(tokenResponse, res)
          return
        }
        const token = await tokenResponse.json() as { access_token?: unknown; expires_in?: unknown }
        if (typeof token.access_token !== 'string' || !token.access_token.trim() ||
          typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
          accessToken = null
          tokenExpiry = 0
          res.status(502).json({ error: 'Reddit authentication failed' })
          return
        }
        accessToken = token.access_token
        tokenExpiry = startedAt + token.expires_in * 1000
      }

      const url = new URL(`https://oauth.reddit.com/r/${subreddit}/new`)
      url.searchParams.set('limit', String(pageSize))

      const posts: RedditPost[] = []
      let after: string | null = null
      let retriedUnauthorized = false
      for (let page = 0; page < MAX_PAGES; page++) {
        if (after) url.searchParams.set('after', after)
        const response = await fetchReddit(url.toString(), {
          signal,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': USER_AGENT
          }
        })

        if (response.status === 401 && !retriedUnauthorized) {
          accessToken = null
          tokenExpiry = 0
          retriedUnauthorized = true
          const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')
          const tokenResponse = await fetchReddit('https://www.reddit.com/api/v1/access_token', {
            method: 'POST',
            signal,
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT
            },
            body: new URLSearchParams({
              grant_type: 'password',
              username: REDDIT_USERNAME!,
              password: REDDIT_PASSWORD!
            })
          })
          if (!tokenResponse.ok) {
            upstreamError(tokenResponse, res)
            return
          }
          const token = await tokenResponse.json() as { access_token?: unknown; expires_in?: unknown }
          if (typeof token.access_token !== 'string' || !token.access_token.trim() ||
            typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
            res.status(502).json({ error: 'Reddit authentication failed' })
            return
          }
          accessToken = token.access_token
          tokenExpiry = now() + token.expires_in * 1000
          page--
          continue
        }
        if (!response.ok) {
          upstreamError(response, res)
          return
        }

        const { data } = await response.json() as Listing
        let reachedCutoff = false
        for (const { data: post } of data.children) {
          if (!Number.isFinite(post.created_utc)) continue
          if (post.created_utc < cutoff) reachedCutoff = true
          else if (post.created_utc <= newestAllowed) posts.push(post)
        }

        // /new is newest-first, so a page past the cutoff completes the window.
        after = reachedCutoff ? null : data.after
        const remaining = response.headers.get('x-ratelimit-remaining')
        if (!after || (remaining !== null && Number(remaining) < 1)) break
      }

      if (!posts.length) {
        res.status(404).json({ error: 'No posts found' })
        return
      }

      const timestamps = posts.map(post => post.created_utc)
      res.json({
        ...processRedditData(posts),
        sample: {
          postCount: posts.length,
          oldestCreatedUtc: Math.min(...timestamps),
          newestCreatedUtc: Math.max(...timestamps),
          truncated: Boolean(after)
        }
      })
    } catch {
      if (signal.aborted) {
        res.status(504).json({ error: 'Reddit analysis timed out' })
        return
      }
      res.status(500).json({ error: 'Internal error' })
    }
  })

  return app
}

function processRedditData(posts: RedditPost[]) {
  const bins: Record<string, { total: number; count: number }> = {}

  posts.forEach((post) => {
    const date = new Date(post.created_utc * 1000)
    const day = date.getUTCDay()
    const hour = date.getUTCHours()
    const score = (post.score || 0) + (post.num_comments || 0)
    const key = `${day}-${hour}`

    if (!bins[key]) bins[key] = { total: 0, count: 0 }
    bins[key].total += score
    bins[key].count += 1
  })

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const heatmapData: Array<{ x: number; y: number; z: number; day: string; formattedTime: string }> = []
  const timeScores: Array<{ day: string; hour: number; score: number; formattedTime: string }> = []

  for (const key in bins) {
    const [day, hour] = key.split('-').map(Number)
    const avg = bins[key].total / bins[key].count
    const formattedHour = hour % 12 || 12
    const ampm = hour < 12 ? 'AM' : 'PM'
    heatmapData.push({ x: hour, y: day, z: avg, day: dayNames[day], formattedTime: `${dayNames[day]} ${formattedHour}${ampm}` })
    timeScores.push({ day: dayNames[day], hour, score: avg, formattedTime: `${dayNames[day]} ${formattedHour}${ampm}` })
  }

  const bestTimes = timeScores.sort((a, b) => b.score - a.score).slice(0, 3)
  return { heatmapData, bestTimes }
}

if (require.main === module) {
  const PORT = process.env.PORT || 3001
  createApp().listen(PORT, () => {
    console.log(`Reddit analyzer server running on port ${PORT}`)
  })
}
