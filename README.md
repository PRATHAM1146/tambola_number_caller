# Tambola Caller

A static website that calls Tambola / Housie numbers from 1 to 90 with spoken announcements.
No build step, no server code, no API keys.

## Files

```
site/                  Deploy this folder as the website root
  index.html           The caller
  privacy.html         Privacy policy
  terms.html           Terms and conditions
  favicon.svg          Favicon (modern browsers)
  favicon.ico          Favicon (legacy browsers and crawlers)
  favicon-32.png       Favicon (PNG fallback)
  apple-touch-icon.png Home screen icon for iPhone and iPad
  assets/style.css
  assets/app.js
tests/
  test_caller.py       Automated checks for every item in the spec's testing list
```

## Run it locally

Open `site/index.html` in Chrome or Edge. Everything works from the file, including voice.

## How the no-repeat logic works

- On load and on every reset, `numberPool` is filled with 1 to 90 and shuffled once with a Fisher-Yates shuffle driven by `crypto.getRandomValues` with rejection sampling, so every order is equally likely.
- Each call `pop()`s exactly one number from the pool, checks it is an integer from 1 to 90 that is not already in `calledNumbers`, then records it.
- The pool is only rebuilt when the user confirms Reset.
- One deadline-based interval drives the countdown. It is always cleared before a new one starts, and it does not run while a number is being spoken.

## Run the tests

```
pip install playwright
playwright install chromium
python tests/test_caller.py
```

The test plays full games in headless Chromium with a fake clock and a recording speech engine. It covers board contents, green highlighting, no duplicates across 21 full games, countdown, pause and resume, repeat, manual calls, rapid clicking, reset, completion, mute, missing speech support and layout at phone, tablet and desktop widths.

## Launch checklist

Do not make the site public until every item is done.

1. **Fill in the legal pages.** In `privacy.html` and `terms.html`, replace every highlighted bracketed field: `[Operator name]`, `[contact email]`, `[hosting provider]`, `[jurisdiction]`. Search for `[` to find them all. Have someone qualified review both pages for your situation.
2. **Deploy `site/` to a static host**, for example Cloudflare Pages, Netlify, Vercel or GitHub Pages. Upload or connect the `site` folder as the publish directory. No build command is needed.
3. **Connect the custom domain** in your host's domain settings. The host shows the exact DNS records to add at your domain registrar (usually a CNAME for `www` and an A, ALIAS or CNAME-flattened record for the bare domain). Turn on HTTPS. Wait for the certificate to be issued, then open the domain and check the padlock.
4. **Check the favicon** shows in the browser tab on the live domain.
5. **Check there is no "Made with" badge.** This code adds none. Some free hosting plans inject one, so look at the live page and switch the setting off or upgrade the plan if needed.
6. **Check the footer links** to the privacy policy and the terms open on the live domain.
7. **Test the voice** on the live domain in Chrome and Edge with the Test Voice button.

## Browser notes

- Voice uses the browser's built-in Web Speech API. Voices labelled "online" in the voice list send the announcement text to Google or Microsoft to produce audio; this is disclosed in the privacy policy.
- Browsers only allow speech after a click, so the first announcement is made from the Start Game button.
- Fonts are loaded from Google Fonts, which is also disclosed in the privacy policy. To avoid that request, download Barlow Condensed (600, 700) and Source Sans 3 (400, 600), add them with `@font-face` in `style.css` and remove the Google Fonts `<link>` tags from the three HTML files, then update the Fonts section of the privacy policy.
