# PCB Gerber Aligner

PCB Gerber Aligner is a Tauri + React desktop tool for visually aligning PCB Gerber layers with scanned board images. It helps compare copper, drill, outline, and scan-derived regions after manual or assisted registration.

## Features

- Import Gerber output folders and scan image folders locally.
- Detect common PCB layer types and switch visible layer combinations.
- Align scan images with offset, scale, rotation, and line-based calibration.
- Extract scan regions with threshold, color range, and eyedropper keying controls.
- Generate an on-screen deviation map for visual comparison.
- Store per-scan alignment and extraction settings in local browser storage.

All imported files are processed locally. This repository does not include real PCB design files, scan images, production data, or sample customer projects.

## Requirements

- Node.js
- npm
- Rust toolchain
- Tauri prerequisites for your operating system

## Install

```bash
npm install
```

## Development

```bash
npm run tauri:dev
```

## Build

```bash
npm run tauri:build -- --no-bundle
```

The Windows executable is generated at:

```text
src-tauri/target/release/pcb-gerber-aligner.exe
```

## Verify

```bash
npm test
```

The test command runs linting and a production frontend build. Real Gerber and scan files are intentionally not included in the repository.

## Data And Privacy

- No uploaded files are sent to a remote service by the application.
- User-selected directories are stored locally for convenience.
- Alignment calibration records are stored locally in the app webview storage.
- Do not commit private Gerber files, scan images, generated release binaries, or local build outputs.

## License

MIT
