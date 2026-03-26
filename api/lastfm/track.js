export default async function handler(req, res) {
  const { artist, track } = req.query;
  const apiKey = process.env.LASTFM_API_KEY;

  if (!artist || !track) {
    return res.status(400).json({ error: 'Missing artist or track' });
  }

  const url =
    'https://ws.audioscrobbler.com/2.0/?' +
    new URLSearchParams({
      method: 'track.getInfo',
      api_key: apiKey,
      artist,
      track,
      format: 'json',
    });

  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(500).json({ error: 'Failed to fetch track info' });
  }
}