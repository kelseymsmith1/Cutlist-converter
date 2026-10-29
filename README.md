# Cutlist Converter

Turns a CabinetSense (SketchUp) cutlist CSV into a CWorkshop cutting-list `.xlsx`.

1. **Boards** – each CabinetSense material is matched to a CWorkshop board (suggested automatically, remembered).
2. **Edge tape** – each board + CabinetSense edge letter maps to a tape (suggested from the board type, remembered). X = scribe = no tape.
3. **Checks** – unmatched boards, Left/Right pairs that differ, 3-of-4 edges banded, visible parts with no banding, parts larger than the sheet.
4. **Parts** – grouped by cabinet; click an edge to change it, or tick parts and edit in bulk (edges, board, "no banding is right").

Download produces CWorkshop's 12-column template. Identical parts are merged; dimensions are rounded to whole mm; banded parts get edge finish `RD`.

## How it runs
- Static site (`index.html`, `app.js`, `core.js`, `styles.css`) – the CSV never leaves the browser.
- `api/decors.js` – Vercel function that reads CWorkshop's catalogue from the search endpoint used by their own cutlist tool (no official API), cached at the edge for 24 h. The browser also keeps the last copy as a fallback.
- Mappings and per-job edits are saved in the browser (localStorage).

## Deploy
Import this repo in Vercel (no framework, no build command). Nothing to configure.

## Notes
- CabinetSense banding order Bottom, Top, Left, Right → L1, L2, W1, W2. Length = grain direction.
- The catalogue endpoint is unofficial and may change.
