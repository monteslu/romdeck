# Themes

romdeck's themed view is an EmulationStation/ES-DE frontend reimplemented in
browser tech. Themes are the **ES-DE XML format** — romdeck invents no format of
its own — rendered as DOM + CSS instead of OpenGL.

> ⚠️ **Status: real community themes do not render yet.** The engine reads the
> ES-DE format but only in a *flattened* form: conditionals as attributes on
> views/elements. Real themes nest their content inside `<variant>` /
> `<aspectRatio>` / `<fontSize>` wrapper elements and reach their views through
> includes at every depth — which the parser does not descend into. Loading
> `modern-es-de` yields **0 elements** (a blank screen). Root cause, evidence
> and the fix are in `PLAN.md` §16f. What works today is the bundled
> `romdeck-default` and themes written in the same flattened subset.

Drop a theme folder in `<userData>/themes/<name>/` and it appears in the theme
picker. Bundled themes live in the app's `themes/` directory.

```
<theme>/
  capabilities.xml   variants, color schemes, aspect ratios
  theme.xml          the layout
  …assets            images referenced by relative path
```

## Supported subset

The engine renders a documented subset and **ignores anything it doesn't know**
— an unsupported theme renders partially rather than failing.

**Views:** `system`, `gamelist`, `desktop` (romdeck extension — see below)

**Elements:** `image`, `text`, `carousel`, `textlist`, `video`, `rating`,
`datetime`

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

`themes/romdeck-default/` is the reference implementation — the shipped theme is
authored in this same format, so the engine is always dogfooding it.

## Not yet supported

Grid view, `<gameselector>`, Lottie animations, badges, scrollable containers,
per-system theming (`system.theme` folders), and theme-side font files. Video
elements are declared and positioned but not yet playing footage.
