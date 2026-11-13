# TS 82 CAD

A small AutoCAD-style drawing tool for TS 82, Exploring STEM through Geometry, at Everett Community College. It runs in the browser and works offline. Nothing a student draws leaves their computer: drawings stay in the browser and save as `.dxf` files.

**Open it:** https://stem-evcc.github.io/Geo-CAD/ (the capitals matter: Pages addresses follow the repo name exactly)

**Proof Builder:** https://stem-evcc.github.io/Geo-CAD/proofs.html. Students drag reason tiles into two-column proofs, like the laser-cut tiles from Weeks 7 and 8. It has the Week 8 packet proofs (Proof 1, Proof 2, Done early) plus angle and triangle practice: 13 proofs in all. **Check my proof** marks each row and ticks the proof checker's list; **Give me a hint** points at the first row to fix. A link can open one proof directly, for example `proofs.html#square-check`. When a statement tile goes into a row, the picture lights up what it names (blue for the left side, pink for the right, purple where they share), with a one-line caption; while dragging, it previews over each row, and a small copy of the picture follows along when the main one has scrolled away. The white bunny loafs while they work and flops when a proof holds. Like the CAD, it is one file (`proofs.html`) and nothing leaves the student's computer.

**The bunny:** a bunny pops up in the bottom corner with a tip when a student is stuck (an error with a known fix, a paver slip, a minute with nothing happening) and flops when the plot is clean. Click it to send it away; **BUNNY** in the status bar turns it off.

## Turning on the site (once)

1. In this repo: **Settings → Pages**.
2. Under **Build and deployment**, Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save.
3. After a minute or two the address above works. It's https, so Chrome and Edge show the real Save dialog.

## Updating it

Replace `index.html` with the newest `ts82-cad.html` (from the week's `4-ts82-cad/` folder in the TS 82 materials) and commit. The site updates in a minute or two. Students already on the page reload to get it.

`.nojekyll` tells GitHub Pages to serve the file as it is.
