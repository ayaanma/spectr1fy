export default function handler(req, res) {
  const apiKey = process.env.LASTFM_API_KEY;

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const cb = `${proto}://${host}/`;

  const url =
    'https://www.last.fm/api/auth/?' +
    new URLSearchParams({
      api_key: apiKey,
      cb,
    });

  res.redirect(url);
}