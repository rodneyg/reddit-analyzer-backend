# Reddit Analyzer Backend

This is the secure backend for [Reddit Post Time Analyzer](https://github.com/yourusername/reddit-analyzer), a tool that finds the best times to post on any subreddit based on real engagement data.

This backend handles:

- Reddit OAuth2 token exchange using **client credentials**
- Authenticated Reddit API requests for latest posts
- Engagement analysis logic (upvotes + comments)
- API responses consumed by the frontend

---

## 🔐 Why a Backend?

Reddit’s OAuth API requires secret credentials. To prevent leaking them in client-side code, this backend acts as a secure proxy that:

- Authenticates with Reddit using your account  
- Fetches and processes subreddit post data  
- Returns clean JSON results to the frontend

---

## 🚀 Deploy to Render (Recommended)

### 1. One-Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/docs/deploy-from-repo)

### 2. Add Environment Variables

| Key                  | Description                      |
|----------------------|----------------------------------|
| `REDDIT_CLIENT_ID`   | From your Reddit app settings    |
| `REDDIT_CLIENT_SECRET` | From Reddit app                 |
| `REDDIT_USERNAME`    | Your Reddit username             |
| `REDDIT_PASSWORD`    | Your Reddit password             |
| `PORT`               | Optional (defaults to 3001)      |

---

## 🧪 Local Development

### Clone and install:

```bash
git clone https://github.com/rodneyg/reddit-analyzer-backend.git
cd reddit-analyzer-backend
npm install
```

### Create .env

```
REDDIT_CLIENT_ID=your_id
REDDIT_CLIENT_SECRET=your_secret
REDDIT_USERNAME=your_username
REDDIT_PASSWORD=your_password
```

### Run locally:

```bash
npm run dev
```

Visit: http://localhost:3001/analyze?subreddit=SIBO

⸻

## 📦 API Endpoint

**GET /analyze?subreddit={name}&days=30**

### Returns:

```json
{
  "heatmapData": [...],
  "bestTimes": [...]
}
```

	•	heatmapData: Array of day/hour bins with average engagement scores
	•	bestTimes: Top 3 day/hour slots sorted by average engagement

⸻

## 🛠 Tech Stack
	•	Node.js
	•	Express.js
	•	TypeScript
	•	Reddit OAuth2
	•	Render (for hosting)

⸻

## 📄 License

MIT — Use it, fork it, improve it. Just don’t leak your Reddit credentials.

---
