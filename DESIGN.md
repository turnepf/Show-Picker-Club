---
name: Show Picker Club
description: A warm, shared record of what a small TV club is watching — paper, not glass.
colors:
  body: "oklch(0.86 0.025 50)"
  surface: "oklch(0.985 0.003 50)"
  surface-2: "oklch(0.955 0.014 50)"
  border: "oklch(0.78 0.020 50)"
  border-soft: "oklch(0.83 0.014 50)"
  ink: "oklch(0.22 0.025 50)"
  ink-muted: "oklch(0.40 0.018 50)"
  ink-quiet: "oklch(0.48 0.015 50)"
  ink-faint: "oklch(0.60 0.012 50)"
  accent: "oklch(0.69 0.15 50)"
  accent-hover: "oklch(0.60 0.16 50)"
  accent-soft: "oklch(0.95 0.04 50)"
  list-watching: "oklch(0.58 0.13 150)"
  list-waiting: "oklch(0.60 0.09 230)"
  list-recommending: "oklch(0.55 0.13 340)"
  tab-watching: "oklch(0.42 0.13 150)"
  tab-waiting: "oklch(0.40 0.09 230)"
  tab-recommending: "oklch(0.40 0.13 340)"
  tab-up-next: "oklch(0.45 0.16 50)"
  info: "oklch(0.55 0.11 230)"
  danger: "oklch(0.55 0.18 25)"
  danger-deep: "oklch(0.38 0.18 25)"
  star: "oklch(0.83 0.16 90)"
  header-bg: "oklch(0.22 0.025 50)"
typography:
  display:
    fontFamily: "ui-serif, 'New York', 'Iowan Old Style', Georgia, serif"
    fontSize: "clamp(2rem, 6.5vw, 2.75rem)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "ui-serif, 'New York', 'Iowan Old Style', Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "ui-serif, 'New York', 'Iowan Old Style', Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.2
rounded:
  xs: "4px"
  sm: "6px"
  md: "12px"
  lg: "18px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-cancel:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-empty-cta:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 22px"
  tab-active:
    backgroundColor: "{colors.tab-up-next}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "8px 4px"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "24px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "10px 14px 10px 18px"
  list-chip:
    backgroundColor: "#ffffff"
    textColor: "{colors.list-watching}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
---

# Design System: Show Picker Club

## 1. Overview

**Creative North Star: "The Shared Almanac"**

Show Picker Club looks like a warm paper almanac a small group of friends keeps together: a curated, color-coded record of what everyone is watching. The member page is the canonical surface; every other screen is measured against it. The mood is domestic and editorial at once. A serif display face gives section headers the authority of a printed page, system sans carries every piece of data underneath, and the body is a committed warm taupe (`oklch(0.86 0.025 50)`) rather than the usual near-white. Cards float on that taupe as near-white paper. Nothing shouts.

The system runs on **restraint**. There is exactly one earned accent (a brand orange at `oklch(0.69 0.15 50)`), reserved for primary actions, the current selection, and live state. Color otherwise comes from a quiet four-list vocabulary (sage / steel / clay-rose / orange) that maps to the product's four lists and nowhere else. Surfaces are flat at rest; depth appears only on genuinely raised layers (the landing card, modals, toasts), and even then as a soft ink-tinted ambient shadow, never a hard drop. The four narrow lists "force a clear judgement," and the visual language mirrors that discipline: every element earns its place or it's cut.

This explicitly rejects the "AI made this" surface. No gradient text, no glassmorphism, no side-stripe callouts, no tiny uppercase tracked eyebrow over every section, no identical icon-card grids. Warmth is carried by the taupe body, the serif, and the rare accent, not by decoration.

**Key Characteristics:**
- Warm taupe paper body; near-white cards float on it.
- Serif for headers, system sans for everything else. No third typeface.
- One orange accent, used on ≤10% of any screen.
- Quiet four-list color vocabulary, never decorative.
- Flat surfaces; shadow only on raised layers, soft and ink-tinted.
- Every action confirms with a toast; reversible ones offer Undo.

## 2. Colors

A warm-neutral foundation (hue 50 throughout the neutrals) with a single orange accent and a restrained list vocabulary borrowed from the product's four lists.

### Primary
- **Brand Orange** (`oklch(0.69 0.15 50)`): The one earned accent. Primary action buttons (Add, Save), the current/selected state, live-state indicators (next-season dates, the expanded-row chevron), and one-tap add buttons. Hover deepens to `oklch(0.60 0.16 50)`. `accent-soft` (`oklch(0.95 0.04 50)`) is a tinted hover wash only, never a body fill.

### Secondary — The List Vocabulary
Four hues, one per product list. Tuned for outline pills and quiet accents at the `list-*` lightness; deepened to the `tab-*` variants whenever white text sits on top.
- **Sage / Watching** (`oklch(0.58 0.13 150)`, white-text variant `oklch(0.42 0.13 150)`).
- **Steel / Waiting** (`oklch(0.60 0.09 230)`, white-text variant `oklch(0.40 0.09 230)`).
- **Clay Rose / Recommending** (`oklch(0.55 0.13 340)`, white-text variant `oklch(0.40 0.13 340)`). Also carries the italic "Suggested via" attribution.
- **Up Next** uses the Brand Orange; its white-text tab variant is `oklch(0.45 0.16 50)`.

### Tertiary — Semantic
- **Info Blue** (`oklch(0.55 0.11 230)`): network deep-links.
- **Danger** (`oklch(0.55 0.18 25)`) and **Danger Deep** (`oklch(0.38 0.18 25)`): destructive actions and error toasts. Deep variant carries white text.
- **Star Gold** (`oklch(0.83 0.16 90)`): rating stars only.

### Neutral
- **Taupe Body** (`oklch(0.86 0.025 50)`): the committed page background. The brand's warmth lives here.
- **Surface** (`oklch(0.985 0.003 50)`) / **Surface-2** (`oklch(0.955 0.014 50)`): near-white card, and the subtly recessed panel inside it.
- **Header / Ink** (`oklch(0.22 0.025 50)`): the dark warm near-black used for the member-page header band and as the deepest ink. The same value backs toasts.
- **Ink ramp**: `ink` (`0.22`) for primary text, `ink-muted` (`0.40`) for secondary, `ink-quiet` (`0.48`, AA-large only — fine print and easter eggs), `ink-faint` (`0.60`, placeholders and decoration only).
- **Borders**: `border` (`oklch(0.78 0.020 50)`) for visible edges, `border-soft` (`oklch(0.83 0.014 50)`) for quiet row separators.

### Named Rules
**The One Accent Rule.** The brand orange appears on ≤10% of any given screen. Its rarity is what makes "add this" and "this is selected" read instantly. If two oranges compete on a screen, one is wrong.

**The Deep-Variant Rule.** A `list-*` color is for outline pills, hover tints, and decoration. The moment white text sits on a list color, switch to its `tab-*` variant. White on a `list-*` fill fails AA; white on a `tab-*` fill passes it (≥4.5:1). This rule exists because we shipped the violation once.

## 3. Typography

**Display Font:** `ui-serif, 'New York', 'Iowan Old Style', Georgia, serif`
**Body Font:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
**Mono Font:** `ui-monospace, 'SF Mono', Menlo, Consolas, monospace` (defined, reserved; not used in chrome)

**Character:** A warm serif against a neutral system sans — pairing on a true contrast axis (serif vs. sans), not two near-identical sans faces. The serif gives headers the feel of a printed almanac; the sans keeps dense show data crisp and native on every device. Both are system fonts: zero web-font load, zero FOUT.

### Hierarchy
- **Display** (serif, 600, `clamp(2rem, 6.5vw, 2.75rem)`, lh 1.05, ls -0.02em): the landing hero only. Ceiling is ~2.75rem — the app whispers; it never shouts.
- **Headline** (serif, 500–600, 1.375rem / `--text-lg`, lh 1.2): section titles and modal titles. `text-wrap: balance`.
- **Title** (serif, 600, 1.125rem / `--text-md`): empty-state headlines.
- **Body** (sans, 400, 1rem / `--text-base`, lh 1.4–1.55): show info and prose. Cap prose at 65–75ch.
- **Label** (sans, 500, 0.8125rem–0.75rem, `ink-muted`): form labels, tab text, metadata. Sentence case.

### Named Rules
**The One Serif Rule.** Exactly one serif display face and one system sans. A third typeface is indecision, not richness. Hierarchy comes from weight and the serif/sans switch, never from a new family.

## 4. Elevation

Flat by default. Surfaces rest on the taupe body with hairline borders, not shadows. Depth is reserved for layers that are genuinely lifted off the page — and even those use a soft, low-contrast shadow tinted with the ink hue (`oklch(0.18 0.03 50 / …)`), never a hard black drop. The look is paper on a desk, not glass floating in space.

Two of these are CSS custom properties in `styles.css` (`--shadow-card`, `--focus-ring`); use the token, not the raw value.

### Shadow Vocabulary
- **Primary content card** (`box-shadow: 0 1px 2px oklch(0.18 0.03 50 / 0.06), 0 14px 44px oklch(0.18 0.03 50 / 0.07)`): the landing card and the member-page `main`. A whisper of lift, mostly the long soft second layer.
- **Secondary card** (`var(--shadow-card)` = `0 1px 2px oklch(0.18 0.03 50 / 0.06), 0 8px 28px oklch(0.18 0.03 50 / 0.06)`): a slightly lighter lift for operator-page wrap cards and the vibe hero. The shared token.
- **Modal** (`box-shadow: 0 20px 60px rgba(0,0,0,0.2)`): the one place a heavier shadow is right, because the modal must read as above everything.
- **Toast** (`box-shadow: 0 4px 12px oklch(0.18 0.03 50 / 0.18), 0 14px 32px oklch(0.18 0.03 50 / 0.22)`): a floating pill, lifted clearly off the content.
- **Focus ring** (`var(--focus-ring)` = `0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent)`): not elevation, but the only other use of the shadow channel — a soft accent halo on focused inputs. The shared token; every focusable input/select/textarea uses it.

### Named Rules
**The Flat-By-Default Rule.** Rows, chips, and panels are flat with hairline borders. If you're reaching for a shadow on a list row, stop — that depth isn't earned. Shadow is for the card, the modal, and the toast. Test: if it looks like a 2014 app, the shadow is too dark and the blur is too tight.

## 5. Components

### Buttons
- **Shape:** gently rounded, 6px (`--rounded-sm`); pill (999px) for the empty-state and toast CTAs.
- **Primary** (Add / Save): accent fill, ink text, weight 700, `padding: 8px 16px`. Hover → `accent-hover`.
- **Cancel / Secondary:** `surface-2` fill, ink text. Hover lightens to `surface`.
- **Ghost-on-dark** (Log in / Search, in the header band): `rgba(255,255,255,0.15)` fill, white text, 1px translucent-white border. Hover raises fill opacity. This is the only ghost treatment, and it only lives on the dark header.
- **Row actions:** the always-visible primary action sits inline on the row; secondary actions (including the `danger` variant for Archive) live inside the expanded row, never shouting.

### Tabs (signature component)
The four-list switcher in the dark header is the system's signature element.
- **Inactive:** transparent fill, `rgba(255,255,255,0.6)` text, 1px translucent-white border, 6px radius.
- **Active:** filled with the list's **`tab-*`** deep variant (per the Deep-Variant Rule), white text, weight 600. Each list owns its color: sage, steel, clay-rose, orange.
- **States:** hover brightens inactive text and border; active is unmistakable by fill. AA-verified at the 12px mobile size.

### List Chips
- **Style:** outline pill, 1.5px border in the list color, matching text color, 6px radius, 34px tall.
- **State:** selected inverts to a filled chip (list color fill, white text). Used for the add-to-list picker.

### Cards / Containers
- **The one card:** the landing/content card. Near-white `surface`, 18px radius (14px on mobile), soft resting shadow, generous padding (44px desktop / 22–28px mobile).
- **Strictly no nested cards.** Rows live flat *inside* the card, separated by `border-soft` hairlines.

### Show Row
- **Shape:** flex, baseline-aligned, `border-soft` bottom hairline, 7px vertical padding.
- **Title:** weight 600; when expandable, a dotted underline plus a 16px chevron that rotates 180° and turns accent on expand (0.18s ease-out).
- **Metadata:** "Next up" dates and "Recommended by" stay always-visible; genre, cast, and notes collapse into the expand. Progressive disclosure, not a modal.

### Inputs / Fields
- **Style:** white fill, 1px `border`, 6px radius, `padding: 10px 12px`. Serif-free; label is a 13px `ink-muted` sans line above.
- **Focus:** accent border plus a 3px accent halo (`color-mix(in oklch, var(--accent) 22%, transparent)`). Never remove the outline without this replacement.

### Toast
- **Style:** dark ink pill, `surface` text, bottom-center stack, `safe-area-inset` aware, slides up 20px on entry (0.22s ease-out; disabled under reduced motion).
- **Action:** an accent-text Undo button on reversible/destructive toasts (6-second window).
- **Error variant:** `danger-deep` fill, white text.

### Empty State
- **Style:** centered, serif `title` headline + `ink-muted` help line (max 360px) + a pill accent CTA.
- **Voice:** teaches the list's purpose in the moment ("Once you've watched something worth recommending, move it here"), never a blank "nothing here." Different copy for own page vs. guest view.

## 6. Do's and Don'ts

### Do:
- **Do** anchor every new surface on the member page: taupe body, near-white card, serif headers, sans body, one orange accent.
- **Do** keep the accent rare — primary action, current selection, and live state only (The One Accent Rule).
- **Do** use the `tab-*` deep variant the instant white text sits on a list color (The Deep-Variant Rule).
- **Do** keep surfaces flat; reach for shadow only on the card, modal, and toast (The Flat-By-Default Rule).
- **Do** confirm every action with a toast, and give Undo on anything reversible or destructive.
- **Do** teach in empty states — say what the list is for.
- **Do** verify body text ≥4.5:1 and large text ≥3:1 before shipping. The tab-contrast fix is the cautionary tale: a `list-*` fill measured 2.85:1 under white.
- **Do** prefer inline progressive disclosure (the row expand) over a modal.

### Don't:
- **Don't** use side-stripe borders (`border-left`/`border-right` >1px as a colored accent). Use full borders or a tint.
- **Don't** use gradient text (`background-clip: text` on a gradient). Emphasis comes from weight and the serif, not from color tricks.
- **Don't** use glassmorphism — no decorative blur or glass cards. This is paper, not glass.
- **Don't** add a second display font. One serif + one system sans is the entire pairing (The One Serif Rule).
- **Don't** put gray text on the dark header or on the tabs — use white at a controlled opacity (≥0.6).
- **Don't** stack the tiny uppercase tracked eyebrow above every section. It's the saturated AI tell.
- **Don't** nest cards, or repeat identical icon-card grids.
- **Don't** push the display heading above ~2.75rem or shrink any text below its AA contrast. The app whispers.
- **Don't** reach for a modal first. The member page dropped its edit-mode toggle for inline expansion; match that instinct.
