# TS 82 CAD

A small AutoCAD-style drawing tool for TS 82, Exploring STEM through Geometry, at Everett Community College. It runs in the browser and works offline. Nothing a student draws leaves their computer: drawings stay in the browser and save as `.dxf` files.

**Open it:** https://stem-evcc.github.io/Geo-CAD/ (the capitals matter: Pages addresses follow the repo name exactly)

**The bunny:** a bunny pops up in the bottom corner with a tip when a student is stuck (an error with a known fix, a paver slip, a minute with nothing happening) and flops when the plot is clean. Click it to send it away; **BUNNY** in the status bar turns it off.

## Turning on the site (once)

1. In this repo: **Settings → Pages**.
2. Under **Build and deployment**, Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save.
3. After a minute or two the address above works. It's https, so Chrome and Edge show the real Save dialog.

## Updating it

Replace `index.html` with the newest `ts82-cad.html` (from the week's `4-ts82-cad/` folder in the TS 82 materials) and commit. The site updates in a minute or two. Students already on the page reload to get it.

`.nojekyll` tells GitHub Pages to serve the file as it is.
