# Downhill Dash

A retro downhill ski game in plain HTML, CSS and JavaScript. No build step, no dependencies.

Dodge trees and rocks, hit jumps for style points, and once you pass 2,000m, keep moving. Something is coming down the hill after you.

## Controls

- **← →** turn (keep pressing to stop, then side-step)
- **↓ / ↑** point straight down / stop
- **Shift or F** boost (drains the boost bar, refills over time)
- **Mouse** point to steer, hold click to boost
- **Touch** drag to steer, hold the BOOST button
- **P / Esc** pause

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Downhill Dash"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/downhill-dash.git
git push -u origin main
```

(Create the empty `downhill-dash` repo on github.com first.)

### 2. Deploy on Vercel

1. Go to https://vercel.com/new and import the GitHub repo.
2. Framework preset: **Other**. Leave build command and output directory empty.
3. Click **Deploy**.

Every push to `main` redeploys automatically.

Or from the command line: `npm i -g vercel && vercel --prod`
