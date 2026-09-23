#!/usr/bin/env node
// jev-kilo: run Kilo CLI through a local jev-gateway. Nothing in ~/.config/kilo is modified.
import { kilo } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(kilo);
