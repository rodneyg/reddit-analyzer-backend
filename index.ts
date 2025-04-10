import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const {
  REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET,
  REDDIT_USERNAME,
  REDDIT_PASSWORD
} = process.env

let accessToken: string | null = null
let tokenExpiry = 0

async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (accessToken && now < tokenExpiry - 60_000) {
    return accessToken
  }

  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'reddit-analyzer-script/1.0 by yourusername'
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: REDDIT_USERNAME!,
      password: REDDIT_PASSWORD!
    })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get token: ${res.status} - ${text}`)
  }

  const json = await res.json()
  accessToken = json.access_token
  tokenExpiry = now + json.expires_in * 1000
  return accessToken
}

app.get('/analyze', async (req, res) => {
  const { subreddit, days = '30', limit = '100' } = req.query

  if (!subreddit) {
    return res.status(400).json({ error: 'Subreddit is required' })
  }

  try {
    const token = await getAccessToken()

    const url = `https://oauth.reddit.com/r/${subreddit}/new?limit=${limit}`

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'reddit-analyzer-script/1.0 by yourusername'
      }
    })

    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: text })
    }

    const json = await response.json()
    const posts = json.data?.children?.map((p: any) => p.data) || []

    if (!posts.length) {
      return res.status(404).json({ error: 'No posts found' })
    }

    const result = processRedditData(posts)
    res.json(result)
  } catch (err: any) {
    console.error('Analysis error:', err)
    res.status(500).json({ error: err.message || 'Internal error' })
  }
})

function processRedditData(posts: any[]) {
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

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Reddit analyzer server running on port ${PORT}`)
})