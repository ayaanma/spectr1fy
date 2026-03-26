export default async function handler(req, res) {
  const { user } = req.query;
  const apiKey = process.env.LASTFM_API_KEY;

  if (!user) {
    return res.status(400).json({ error: 'Missing user' });
  }

  const url =
    'https://ws.audioscrobbler.com/2.0/?' +
    new URLSearchParams({
      method: 'user.getRecentTracks',
      user,
      api_key: apiKey,
      limit: '1',
      format: 'json',
    });

  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(500).json({ error: 'Failed to fetch recent tracks' });
  }
}