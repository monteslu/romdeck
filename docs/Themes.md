# Themes

romdeck's themed view is an EmulationStation/ES-DE frontend reimplemented in
browser tech. Themes are the **ES-DE XML format** -- romdeck invents no format of
its own -- rendered as DOM + CSS instead of OpenGL.

Real community themes render. `modern-es-de` and `slate-es-de` are verified by
a conformance harness on every change:

```bash
THEME_REPOS=1 node scripts/theme-conformance.mjs
```

It clones the themes ES-DE itself lists, loads each across every declared
variant / colour scheme / aspect ratio, and **fails if any view yields zero
elements**. Rendering is checked separately, against pixels rather than
counts:

```bash
romdeck --realtheme modern-es-de <roms>
```

which asserts no unresolved `${…}` bindings reach the screen, no images are
broken, and that carousel items actually show their system logos.

## Getting themes

The theme picker (**Start → Themes**) downloads community themes on request
(Art Book Next, Modern and Slate), showing each one's author, licence and
size before anything is fetched. They are **downloaded rather than bundled**: every
one is CC-BY-NC-SA, so shipping them would make romdeck a redistributor of
other people's artwork, and Art Book Next alone is 220 MB against an app that
is otherwise about one.

romdeck bundles **no theme at all**. On first run it installs **Slate**, the
theme ES-DE ships as its own desktop default: about 20 MB of real per-system
artwork, logos and console/controller illustrations for ~150 systems. That is
a download on the user's behalf, not a redistribution -- Slate is CC-BY-NC-SA
and its own CREDITS note the console logos belong to their respective owners,
so it may not ship inside a GPL-3.0 npm package.

If the fetch fails (offline, or no git), the app still starts and says so,
with the error and how to retry, rather than painting a blank screen.

You can also drop any theme folder in `<userData>/themes/<name>/` and it
appears in the picker.

```
<theme>/
  capabilities.xml   variants, color schemes, aspect ratios
  theme.xml          the layout
  …assets            images referenced by relative path
```

## Supported subset

The engine renders a documented subset and **ignores anything it doesn't know**
so an unsupported theme renders partially rather than failing.

**Views:** `system`, `gamelist`, `desktop` (romdeck extension -- see below).
A view block may name several at once: `<view name="system, gamelist">`.

**Elements:** `image`, `text`, `carousel`, `textlist`, `video`, `rating`,
`datetime`, `gamelistinfo`, `badges`, `helpsystem`, `clock`, `systemstatus`

**Structure:** the conditional wrappers real themes are built from --
`<variant>`, `<aspectRatio>`, `<fontSize>`, `<colorScheme>` -- nesting to any
depth, with `<include>` followed at every level. A wrapper's condition applies
to everything inside it. Redeclaring an element name later **merges** onto the
earlier declaration, which is how themes set shared properties once and then
refine a single element.

**Properties:** `pos`, `size`, `maxSize`, `origin`, `rotation`, `opacity`,
`zIndex`, `visible`, `color`, `backgroundColor`, `selectedColor`,
`selectorColor`, `textColor`, `fontSize`, `horizontalAlignment`,
`verticalAlignment`, `lineSpacing`, `itemScale`, `itemSpacing`,
`maxItemCount`, `path`, `text`, `metadata`

Positions and sizes are normalized `0-1` against a fixed-aspect stage, so one
layout is resolution independent. Colors are `RRGGBB` or `RRGGBBAA`.

**Also supported:** `<variables>` with `${name}` substitution, `<include>`,
and `variant` / `colorScheme` / `aspectRatio` attributes on views, elements,
and variable blocks. With nothing selected, the theme's *first declared*
variant and color scheme are the defaults (ES-DE semantics).

## The desktop view (romdeck extension)

ES-DE's format only describes the 10-foot UI, so romdeck adds an optional
`desktop` view that skins the **windowed library**: background, panels, text,
accent colors, and a couple of layout hints.

**Every ES-DE theme restyles the desktop even without this block.** romdeck maps
conventionally-named theme variables onto the same tokens, in this order:

| token | variables tried (first match wins) |
|---|---|
| `bg` | bg, background, backgroundColor, primaryColor, bgColor |
| `bg2` | bg2, panelBg, secondaryBackground, backgroundAlt |
| `panel` | panel, panelColor, cardColor, secondaryColor |
| `line` | line, border, borderColor, separator |
| `ink` | ink, text, textColor, fontColor, primaryText |
| `dim` | dim, textDim, secondaryText, subtleColor, unfocusedColor |
| `accent` | accent, accentColor, selectedColor, highlight, primary |
| `accent2` | accent2, accentSecondary, warning, highlight2 |
| `danger` | danger, error, errorColor, alert |

To be explicit instead, declare them:

```xml
<view name="desktop">
    <text name="bg"><color>0d0f14</color></text>
    <text name="ink"><color>e8ecf4</color></text>
    <text name="accent"><color>4fd1c5</color></text>
    <image name="background"><path>./art/wallpaper.jpg</path></image>
    <grid name="grid"><itemSize>150 0</itemSize></grid>
</view>
```

`variant` / `colorScheme` filtering works here too, so a theme's color schemes
restyle the desktop and big-screen views together. Games without box art get
placeholder tiles generated around the theme's accent hue, so the fallback art
matches the palette.

## Metadata bindings

`<metadata>` on a text or image element pulls live library data:

| Key | Value |
|---|---|
| `system.fullName` | current system name |
| `system.gameCount` | "N games" |
| `game.name` | selected game (DAT-verified name when available) |
| `game.cover` | box art path |
| `game.detail` | verified badge · play count · genre |

## Minimal example

```xml
<theme>
    <variables>
        <accent>4fd1c5</accent>
    </variables>
    <view name="system">
        <text name="title">
            <pos>0.5 0.1</pos>
            <origin>0.5 0.5</origin>
            <metadata>system.fullName</metadata>
            <color>${accent}</color>
            <fontSize>0.06</fontSize>
            <horizontalAlignment>center</horizontalAlignment>
        </text>
        <carousel name="systemCarousel">
            <pos>0.5 0.5</pos>
            <size>0.9 0.34</size>
            <origin>0.5 0.5</origin>
            <maxItemCount>5</maxItemCount>
        </carousel>
    </view>
</theme>
```

**Slate** is the reference implementation: it is what a fresh install renders,
so the engine is always dogfooding a real ES-DE theme rather than a
first-party one written to its own quirks. `scripts/theme-conformance.mjs`
and `scripts/theme-render-sweep.mjs` gate the engine against the wider
catalogue (64 themes, both views, asserted on pixels).

## Metadata bindings, the ES-DE names

Real themes bind through `<metadata>` or `<systemdata>` using ES-DE's own
names, all of which resolve: `gamecount`, `name`, `description`, `genre`,
`developer`, `publisher`, `players`, `releasedate`, `rating`, `playcount`.
`<defaultValue>` covers a game with nothing recorded.

A `<text>` body may also carry a runtime binding -- `${system.fullName}` and its
collection-scoped siblings. These are **not** theme variables (those resolve in
the main process); they are filled in at paint time. romdeck has no
collections, so `${system.fullName.autoCollections}` and its custom equivalent
resolve to empty, which is what themes expect: they declare all three at one
position and rely on the inapplicable ones staying blank.

## Fonts and images

`<fontPath>` files are registered as `@font-face` and applied per element.
Carousel logos come from `<staticImage>` with `${system.theme}` -- the ES-DE
shortname -- substituted per system; a system the theme has no art for falls
back to its name rather than an empty slot. A 1×1 image tinted with `<color>`
(the `box.png` idiom) is rendered as a solid fill.

## Not yet supported

Grid view, `<gameselector>`, Lottie animations, badge *icons* (the element is
positioned but not populated), scrollable containers, and per-system theming
(`system.theme` folders beyond carousel art). Video elements are declared and
positioned but not yet playing footage.
