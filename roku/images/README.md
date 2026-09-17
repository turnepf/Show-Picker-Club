# Channel artwork

The `manifest` references these image assets, all present and generated from the same TV+checkmark
mark as the App Store icon (`ios/.../AppIcon.appiconset/icon-1024.png`) rather than inventing new
branding. Regenerate with `gen_icons.py`-style Pillow scripting if the source mark changes.

| File | Purpose | Size |
|------|---------|------|
| `icon_focus_hd.png` | Channel poster (focused), HD | 336×210 |
| `icon_focus_sd.png` | Channel poster (focused), SD | 214×134 |
| `icon_side_hd.png`  | Channel poster (side), HD | 106×69 |
| `icon_side_sd.png`  | Channel poster (side), SD | 106×69 |
| `splash_hd.jpg`     | Splash, HD | 1280×720 |
| `splash_fhd.jpg`    | Splash, FHD | 1920×1080 |
| `spinner.png`       | Loading spinner glyph | 60×60 |

Palette to match the app: background `#0D0F14`, brand orange `#F29C3D`.
