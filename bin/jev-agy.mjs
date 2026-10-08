#!/usr/bin/env node
// jev-agy: run Antigravity CLI (agy) through a local jev-gateway.
import { agy } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(agy);
