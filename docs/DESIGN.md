# Design: proxflow

## Concept
The page is the as-built drawing of a lab: an engineering sheet on drafting film, with a zone-graded border,
a title block, a parts list, an equipment schedule, general notes and detail views. ProxFlow's whole idea is
"draw the lab, and it gets built", so the page is the drawing. A visitor should leave thinking the tool is
exact: what you draw is what you get.

## Audience and primary action
Sysadmins and lab builders running Proxmox VE, often on a network with no internet. They want to know what it
builds, from what, and whether it will run on a locked-down Windows machine. Primary action: download the
Windows zip.

## Type
Display: Archivo (variable), width 112–118, weight 700, tracking −0.02em. Semi-expanded grotesk reads like the
lettering in a drawing's title block, and the width axis lets the hero go wide without a second family.
Text: Archivo at width 100, 400 and 600.
Mono: Martian Mono (variable), width 87.5–100, 400–600, for every annotation: node names, addresses, the title
block, tables' reference columns, the console. Its square, monoline construction is close to technical-pen
lettering.
Scale: 16 → 18px, ratio 1.2 → 1.333 (scripts/scale.mjs); the hero headline is a hand-set clamp up to 6rem, one sentence per line where it fits.

## Color
- bg (drafting film): oklch(0.965 0.006 210)
- surface (sheet): oklch(0.985 0.004 210)
- ink (technical pen, blue-black): oklch(0.24 0.03 255)
- ink-muted: oklch(0.45 0.025 250)
- line: oklch(0.83 0.012 230)
- construction (non-photo blue): oklch(0.80 0.07 225). Grid, crosshair, guides only, never text.
- accent (redline): oklch(0.53 0.19 27). Only the download action, the As built stamp and focus rings.
- on-accent: oklch(0.985 0.004 210)

Dark mode is a blueprint print of the same sheet: a Prussian-blue sheet with white line, the way drawings
were copied before plotters. Tokens are written as light-dark(film, blueprint) in styles.css.
- bg: oklch(0.235 0.055 257) · surface (sheet): oklch(0.31 0.085 256)
- ink: oklch(0.965 0.012 235) · ink-muted: oklch(0.83 0.035 238) · line: oklch(0.5 0.07 250)
- construction: oklch(0.74 0.1 225); grid at 13%
- accent (button): oklch(0.56 0.19 28) with white text · redline (stamp, focus): oklch(0.76 0.14 33), lighter so
  it holds up on blue
It follows the system setting. A "Blueprint" check box in the masthead overrides it and is remembered
(localStorage proxflow-print); switching feeds the new print down the page with a view-transition wipe
(instant with reduced motion). Without JS the switch is hidden and the system setting still applies.

## Layout
One sheet, 78rem wide. Every section is a region of it: a hairline rule carrying the heading on the left and a
drawing reference on the right, then its content. Dense tables (parts list, equipment schedule) alternate with
airy statements and large detail views. Left edges align throughout; nothing is centered except the stamp.

## Signature
1. The zone-graded border (1–8 across, A–D down) and the title block with real data: version, Node.js
   version, sheet, scale "NTS".
2. The red As built stamp, set at an angle across the drawing: the one element that breaks the grid.

## Wow moment
On load, the lab plots itself: the Proxmox host boundary, then each machine, the vmbr0 bus and drops with their
addresses, the domain-join arcs to dc01, each machine's "ready", and finally the As built stamp lands.
About 2.5s, once. Pointer (fine pointers only): a non-photo-blue crosshair follows the pointer across the sheet
and the title block reads out the zone under it (e.g. "C4").
No JS: the plot is CSS-only, so it still plays; only the crosshair needs JS. Reduced motion: the finished
drawing, nothing moves. Phone: a portrait version of the same drawing (machines stacked, the bus down the right, the join arcs
on the left) runs the full width of the sheet under the headline, and a tap marks a zone for a moment.

## Imagery and texture
An inline SVG drawing of an AD lab (vector, set in the page's fonts), and real screenshots from demo mode shown
as detail views A–D. Nothing hand-drawn beyond boxes, lines and type.

## Motion
The plot, the stamp and the crosshair. Everything else: 150–200ms color and border transitions. Nothing loops.

## Voice
Plain and specific; first person singular where it's my story. Drawing vocabulary structures the page (parts
list, schedule, notes, details) but never becomes puns.

## Social card
`assets/og.png` (1200×630) is the same sheet: headline left, the finished drawing right. It is rendered from the
page CSS with Playwright at reduced motion; regenerate it when the drawing changes.

## Alternatives considered
- Sneakernet manifest: a sealed transfer kit for an air-gapped site; kraft paper, stencil type, the checksum
  as a tamper seal.
- Rack elevation at night: a 42U rack drawing where the lab's machines slide into units with status LEDs;
  dark steel and amber.
