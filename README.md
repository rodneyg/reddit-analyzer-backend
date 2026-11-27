# Reddit Analyzer Backend

This service provides Reddit post data for [Reddit Post Time Analyzer](https://github.com/rodneyg/reddit-analytics). It fetches recent posts from a subreddit and summarizes engagement by UTC day and hour.

## Deploy to Render

Create a **Web Service** in [Render](https://render.com/) and connect `rodneyg/reddit-analyzer-backend`. Set the runtime to Node, the build command to `npm ci && npm run build`, and the start command to `npm start`. Set these environment variables in the Render service:

| Key | Description |
| --- | --- |
| `REDDIT_CLIENT_ID` | Client ID from your Reddit app settings |
| `REDDIT_CLIENT_SECRET` | Client secret from your Reddit app settings |
| `REDDIT_USERNAME` | Reddit account username used for the password grant |
| `REDDIT_PASSWORD` | Password for that Reddit account |
| `PORT` | Optional; defaults to `3001` when running locally |

Keep credentials in Render's environment settings or a local `.env` file. Do not commit `.env`.

## Run locally

Requires Node.js 22 through 24.

```bash
git clone https://github.com/rodneyg/reddit-analyzer-backend.git
cd reddit-analyzer-backend
npm ci
npm run build
npm start
```

To run the tests, use a second terminal in the repository:

```bash
npm test
```

The server listens on port `3001` by default. Set `PORT` to use another port. The local service endpoint is `http://localhost:3001/analyze`.

## Reddit authentication

The backend exchanges the Reddit client ID and client secret using HTTP Basic authentication, then requests a token with Reddit's **OAuth2 password grant** and the configured Reddit username and password. It keeps the access token in memory until it is near expiration. This flow requires Reddit account credentials and should only be used with an account and Reddit app you are authorized to use. The credentials stay on the backend and are not sent to the frontend.

## API

### `GET /analyze`

Required query parameter:

- `subreddit`: subreddit name containing 1 to 21 letters, numbers, or underscores. Do not include `r/`.

Optional query parameters:

- `days`: positive whole number of days to include, default `30`.
- `limit`: posts requested per Reddit listing page, from `1` to `100`, default `100`. The service may request up to 10 pages, stopping at the requested time window or Reddit's reported rate limit.

Example:

```text
http://localhost:3001/analyze?subreddit=programming&days=30&limit=100
```

A successful response contains `heatmapData`, `bestTimes`, and `sample`:

```json
{
  "heatmapData": [{ "x": 14, "y": 2, "z": 42, "day": "Tuesday", "formattedTime": "Tuesday 2PM" }],
  "bestTimes": [{ "day": "Tuesday", "hour": 14, "score": 42, "formattedTime": "Tuesday 2PM" }],
  "sample": {
    "postCount": 1,
    "oldestCreatedUtc": 1795701600,
    "newestCreatedUtc": 1795701600,
    "truncated": false
  }
}
```

`heatmapData` gives average combined score and comment count for each UTC day/hour bin. `bestTimes` contains up to the three bins with the highest average. `sample` reports the number of posts analyzed, the oldest and newest post creation timestamps in Unix seconds, and whether more matching pages remained when collection stopped. An empty time window returns `404`; invalid parameters return `400`. Reddit errors are returned with their status, and timeouts return `504`.
