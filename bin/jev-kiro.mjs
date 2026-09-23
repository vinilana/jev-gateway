#!/usr/bin/env node
// jev-kiro: run Kiro CLI through a local jev-gateway. Nothing in ~/.kiro is modified.
import { kiro } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(kiro);
