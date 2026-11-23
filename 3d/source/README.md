# Geo-CAD 3D (TS 82 Part Studio)

A browser 3D modeler for TS 82 at Everett Community College, built to feel like Onshape: every part starts as a 2D sketch made exact with dimensions and constraints, then features (Extrude, Revolve, patterns, Mirror) turn it into 3D. Sizes can use named variables and formulas (`#width/2`, `sqrt(#run^2 + #rise^2)`, `atan(#rise/12)`).

## Where it lives

Live at https://stem-evcc.github.io/Geo-CAD/3d/. `../index.html` (that is, `3d/index.html`) is the whole app in one file, with no server code; it also opens straight from a computer by double-clicking.

## What's in it

- Sketch tools: line, rectangle, center rectangle, circle, 3-point, center and tangent arcs, polygon, slot, point, sketch fillet, trim, sketch mirror, construction lines, Use edges.
- Sizes and rules: smart Dimension (length, distance, horizontal/vertical, point to line, angle, radius, diameter), Coincident, Horizontal, Vertical, Parallel, Perpendicular, Tangent, Equal, Midpoint, Concentric, Symmetric, Fix. Blue = can still move, black = fully defined, reference dimensions in parentheses.
- Features: Extrude (New, Add, Remove, Intersect; depth, symmetric, through all), Revolve, offset Plane, Linear pattern (1 or 2 directions), Circular pattern, Mirror, sketch on any flat face. Feature list with edit, rename, suppress, delete, rollback bar.
- Live preview while a feature's box is open, with drag handles (arrow for depth, ball for revolve angle, arrow for pattern spacing) that type the new size for you.
- Variables panel, Mass and volume (PLA, PETG, ABS, plywood, acrylic, aluminum, steel), Measure.
- Units switch (mm | in) at the bottom right. It changes what the labels and boxes show, never the part's size; the choice is saved with the part. In inches, a plain number typed in a size box means inches (stored as `2 in`); in a variable or formula, write the unit.
- Export STL button in the toolbar (3D printer; STL is always in millimeters). Export menu: sketch or flat face as DXF/SVG (laser, router, waterjet; red lines), PNG, project file (.json). Autosaves in the browser. Undo and redo.
- Tutorials (graduation cap, top right): seven walk-throughs that ring the exact button to click, show a green spot where to click in the sketch, wait for the student, and offer Do it for me. Lessons: Your first part, Design intent, Variables, Holes, Revolve, Patterns, Get it to the makerspace. The student's own part is kept and can be restored at the end.

## Build from source

```
npm install
node build.mjs        # writes ../index.html (3d/index.html)
```

Source is in `src/` here: `expr.js` (expressions and variables), `solver.js` (constraint solver and degrees of freedom), `regions.js` (closed areas), `model.js` (feature regeneration on the Manifold solid kernel), `view3d.js` (three.js viewport), `sketch.js` (sketch editor), `dialogs.js`, `app.js`, `io.js`, `examples.js`, `help.js`, `tutorial.js` (the walk-throughs), `units.js` (mm and inch display).

Built with three.js (MIT) and Manifold (Apache 2.0).
