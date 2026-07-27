# Bundled fonts

romdeck bundles its UI fonts rather than resolving system ones. A handheld
image, a fresh container and a developer's laptop have wildly different font
sets, and text that reflows or falls back to tofu depending on the machine is
not something a self-check can meaningfully assert on. Bundling makes the
rendered result identical everywhere.

The files are renamed to stable role names (`romdeck-ui`, `romdeck-symbols`)
so a font can be swapped without touching the code that names it. They are
**unmodified copies**; only the filename differs.

| File | Font | Version | Licence |
|---|---|---|---|
| `romdeck-ui.ttf` | DejaVu Sans | 2.37 | Bitstream Vera / public domain (see below) |
| `romdeck-ui-bold.ttf` | DejaVu Sans Bold | 2.37 | Bitstream Vera / public domain (see below) |
| `romdeck-symbols.ttf` | GNU FreeSans | 0412.4271 | GPL-3.0-or-later with font exception |
| `romdeck-symbols-bold.ttf` | GNU FreeSans Bold | 0412.4271 | GPL-3.0-or-later with font exception |

## DejaVu Sans

Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved.
Copyright (c) 2006 by Tavmjong Bah. All Rights Reserved.
DejaVu changes are in public domain.

Released under the Bitstream Vera Fonts Copyright, a permissive licence that
allows redistribution and modification. Full text:
<https://dejavu-fonts.github.io/License.html>

## GNU FreeFont (FreeSans)

Copyright 2002, 2003, 2005, 2008, 2009, 2010, 2012, 2020 GNU Freefont
contributors.

Licensed under the GNU General Public License version 3 **or later**, with
the font exception: embedding the font in a document does not by itself place
that document under the GPL. Full text: <https://www.gnu.org/copyleft/gpl.html>
Project: <https://www.gnu.org/software/freefont/>

romdeck is itself GPL-3.0, so this imposes nothing additional on the app. It
does mean these files must stay redistributable in source form, which they
are: they ship unmodified and are not subsetted.

## Why two families

FreeSans is present specifically for the enclosed-letter glyphs the UI uses
for button prompts (Ⓐ, Ⓑ, …). DejaVu and Noto Sans Symbols2 both *declare*
cmap coverage for those codepoints and then render tofu, which is worth
knowing because it defeats the obvious way of testing for coverage: a lit-pixel
count cannot tell a glyph from a tofu box, since the box is also lit. The
working probe compares against a codepoint the font certainly lacks.
