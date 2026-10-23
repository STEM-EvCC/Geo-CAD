# TS 82 CAD

A small AutoCAD-style drawing tool for TS 82, Exploring STEM through Geometry, at Everett Community College. It runs in the browser and works offline. Nothing a student draws leaves their computer: drawings stay in the browser and save as `.dxf` files.

**Open it:** https://stem-evcc.github.io/geo-cad/ (once Pages is on: Settings → Pages → Deploy from a branch → main, / (root))

## Turning on the site (once)

1. In this repo: **Settings → Pages**.
2. Under **Build and deployment**, Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save.
3. After a minute or two the address above works. It's https, so Chrome and Edge show the real Save dialog.

## Updating it

Replace `index.html` with the newest `ts82-cad.html` (from the week's `4-ts82-cad/` folder in the TS 82 materials) and commit. The site updates in a minute or two. Students already on the page reload to get it.

`.nojekyll` tells GitHub Pages to serve the file as it is.
