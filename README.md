# TS 82 CAD

A small AutoCAD-style drawing tool for TS 82, Exploring STEM through Geometry, at Everett Community College. It runs in the browser and works offline. Nothing a student draws leaves their computer: drawings stay in the browser and save as `.dxf` files.

**Open it:** https://stem-evcc.github.io/Geo-CAD/ (the capitals matter: Pages addresses follow the repo name exactly)

**Proof Builder:** https://stem-evcc.github.io/Geo-CAD/proofs.html. Students drag reason tiles into two-column proofs, like the laser-cut tiles from Weeks 7 and 8. It has the Week 8 packet proofs (Proof 1, Proof 2, Done early) plus angle and triangle practice: 13 proofs in all. **Check my proof** marks each row and ticks the proof checker's list; **Give me a hint** points at the first row to fix. A link can open one proof directly, for example `proofs.html#square-check`. When a statement tile goes into a row, the picture lights up what it names (blue for the left side, pink for the right, purple where they share), with a one-line caption; while dragging, it previews over each row, and a small copy of the picture follows along when the main one has scrolled away. The white bunny loafs while they work and flops when a proof holds. Like the CAD, it is one file (`proofs.html`) and nothing leaves the student's computer.

**The bunny:** a bunny pops up in the bottom corner with a tip when a student is stuck (an error with a known fix, a paver slip, a minute with nothing happening) and flops when the plot is clean. Click it to send it away; **BUNNY** in the status bar turns it off.

**The Build tab (for the final project):** next to Home. Everything works by typed command too, as in AutoCAD.

- **Project sheet** (`PROJECT`, or NEW then Final project): one 12 x 12 in plywood sheet (304.8 mm) for the laser parts, and a dashed 4 x 4 in box (101.6 mm) for the one part cut on the router or waterjet. **Plot** asks which one: the sheet makes the `-LASER` file, the box makes the `-ROUTER` file (moved so the box's corner is at 0,0). The box's plot warns about sharp inside corners a round router bit can't cut.
- **Shapes:** `POLYGON` (`POL`), `ARC` (`A`, three points or center), `FILLET` (`F`: click a rectangle or polygon, Enter rounds every corner; or two lines; `R` sets the radius), `EXPLODE` (`X`). Rounded corners are true arcs in the polyline, so they save to DXF as arcs, offset correctly, and measure exactly.
- **Patterns:** `ARRAYRECT`, `ARRAYPOLAR` (`AR` asks which) and `SCALE` (`SC`, with Reference), each named on its tip bar as a transformation (slides, turns, a dilation).
- **Text** (`TEXT`): words become outlines (closed shapes), so the laser, router and waterjet follow them and the DXF looks the same on every computer. Seven fonts, previewed in the student's own words: Atkinson Hyperlegible Bold, Nunito Black, Arvo Bold, Stardos Stencil Bold (the middles of O, A, B stay on when cut out), Pacifico (joined script: a cut-out word is one piece), and two single-line Hershey fonts for fast scoring. Overlapping outlines are joined, so no laser line runs through the inside of a letter. Pick Score, Engrave or Cut out; the dialog warns when letters would fall apart. One click picks the whole word; `EXPLODE` splits it into letters. Spanish accents (á é í ó ú ñ ü ¿ ¡) are in every font.
- **Area** (`AREA`, also on Home): area and perimeter of a closed shape, or of corners clicked one by one.
- **Model in 3D** (`3D`): the bunny suggests Tinkercad and Onshape, with steps for bringing the drawing along, and **Save a 3D shape (SVG)** writes the red shapes filled, holes as holes, for Tinkercad's Import.

**Tool guide** (`TOOLS`, the tiles button at the top right, or https://stem-evcc.github.io/Geo-CAD/#tools): every button with a looping picture of how it works, what it does and the steps. **Print this page** gives a 7-page handout. Hovering over any button shows the same picture in its card.

**Credits:** Atkinson Hyperlegible (Braille Institute of America), Nunito (The Nunito Project Authors), Arvo (Anton Koovit), Stardos Stencil (Vernon Adams) and Pacifico (The Pacifico Project Authors) are used under the SIL Open Font License 1.1; their outlines are stored in `index.html` so the tool works offline. The single-line fonts are the Hershey fonts, originally created by Dr. A. V. Hershey at the U. S. National Bureau of Standards (data format by James Hurt, Cognition, Inc.). Outlines are joined with [polygon-clipping](https://github.com/mfogel/polygon-clipping) by Mike Fogel (MIT License).

## Turning on the site (once)

1. In this repo: **Settings → Pages**.
2. Under **Build and deployment**, Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save.
3. After a minute or two the address above works. It's https, so Chrome and Edge show the real Save dialog.

## Updating it

Replace `index.html` with the newest `ts82-cad.html` (from the week's `4-ts82-cad/` folder in the TS 82 materials) and commit. The site updates in a minute or two. Students already on the page reload to get it.

`.nojekyll` tells GitHub Pages to serve the file as it is.
