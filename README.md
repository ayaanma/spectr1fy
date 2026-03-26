# [spectr1fy](https://spectr1fy.vercel.app/), a real-time Spotify visualizer

A music visualizer that runs right in your browser.

---

## How it works

The visualizer connects to your [Last.fm](https://www.last.fm/) account. This is done to get the title of the current song, the artist name, and the album cover. The user will then be prompted to share their screen and are expected to share the Spotify tab. The screenshare will feed [spectr1fy](https://spectr1fy.vercel.app/) the audio and the program will create sin wave visuals of the song. No video or audio data is stored, sold, transmitted, or otherwise used in any way besides audio visualization. All visualization runs locally in the browser.

### Limitations

Due to their extreme API limitations, Spotify has made it impossible to release apps as a solo developer. In 2024, they removed the ability to get track audio data. The workaround I applied here is to prompt the user to share their screen so that the program can capture audio input and parse through it manually. In 2025, they capped developers at 5 users and then said that the only way to increase that limit was to have 250,000 monthly users (not sure how that makes sense). This caused me to use the [Last.fm](https://www.last.fm/) API instead. However, due to API limitations, the visualizer lags when the song changes. I plan to create a browser extension to work around the need for [Last.fm](https://www.last.fm/) and hopefully mitigate this delay.
