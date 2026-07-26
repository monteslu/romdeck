# Themes

romdeck's big-screen mode is an EmulationStation/ES-DE frontend reimplemented in
browser tech. Themes are the **ES-DE XML format** — romdeck invents no format of
its own — rendered as DOM + CSS instead of OpenGL.

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

**Views:** `system`, `gamelist`

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
