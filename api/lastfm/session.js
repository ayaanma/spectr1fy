import crypto from 'crypto';

function signLastfm(params, secret) {
  const sig = Object.keys(params)
    .filter((k) => k !== 'format')
    .sort()
    .map((k) => k + params[k])
    .join('') + secret;

  return crypto.createHash('md5').update(sig).digest('hex');
}

export default async function handler(req, res) {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const apiKey = process.env.LASTFM_API_KEY;
  const secret = process.env.LASTFM_SHARED_SECRET;

  const params = {
    method: 'auth.getSession',
    api_key: apiKey,
    token,
  };

  const api_sig = signLastfm(params, secret);

  const url =
    'https://ws.audioscrobbler.com/2.0/?' +
    new URLSearchParams({
      ...params,
      api_sig,
      format: 'json',
    });

  try {
    const r = await fetch(url);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch {
    return res.status(500).json({ error: 'Last.fm request failed' });
  }
}