---
source: Official Electron documentation
library: Electron 43
package: electron
topic: macOS Tray and nativeImage template images
tech_stack: Electron 43 on macOS
fetched: 2026-08-23T00:00:00Z
official_docs: https://github.com/electron/electron/blob/v43.0.0/docs/api/native-image.md
---

## Relevant Electron 43 documentation

### `nativeImage`: High Resolution Image

Electron recognizes `@2x` after an image's base filename as a 2x high-resolution representation. To support multiple densities, put the representations in the same directory and pass the filename without the DPI suffix to Electron. Example naming in the official documentation is `icon.png` plus `icon@2x.png`.

### `nativeImage`: Template Image (macOS)

On macOS, template images consist of black and an alpha channel. Their common use is a menu-bar (`Tray`) icon that adapts to both light and dark menu bars. A template image's base filename should end in `Template`, for example `xxxTemplate.png`; a high-density representation can be named `xxxTemplate@2x.png`.

### `Tray`: macOS platform considerations

- Icons passed to `Tray` should be template images.
- Electron recommends 16x16 at 72 dpi for 1x and 32x32 at 144 dpi for 2x.
- The 2x filename must correspond to the standard filename, and filenames must remain unhashed/unmangled when bundled. Otherwise macOS will not automatically invert the colors or use the high-density image.

Accordingly, an appropriate pair is:

- `speakerTemplate.png`: 16x16 pixels, 72 dpi
- `speakerTemplate@2x.png`: 32x32 pixels, 144 dpi

Pass `speakerTemplate.png`; Electron discovers the adjacent 2x representation.

### `NativeImage.setTemplateImage(option)`

Electron 43 still documents `image.setTemplateImage(option)`, where a true value marks the image as a macOS template image. Filename-based template recognition also remains documented. Therefore `setTemplateImage(true)` remains valid and is useful when explicitly marking a loaded `NativeImage`; with correctly named `*Template.png` resources it is redundant but harmless.

## Official sources

- Electron 43 `nativeImage`: https://github.com/electron/electron/blob/v43.0.0/docs/api/native-image.md#template-image-macos
- Electron 43 `Tray` macOS considerations: https://github.com/electron/electron/blob/v43.0.0/docs/api/tray.md#macos
- Current rendered `nativeImage` API: https://www.electronjs.org/docs/latest/api/native-image
- Current rendered `Tray` API: https://www.electronjs.org/docs/latest/api/tray
