#!/usr/bin/env node
// npx romdeck: launch the app.
//
// A plain Node entry point. There was an Electron dance here (resolve the
// binary, spawn it, explain yourself when it was missing) because Electron
// could not be a runtime dependency and a packaged build; with no Electron,
// npx romdeck is just running the app.
import '../src/ui/main.js';
