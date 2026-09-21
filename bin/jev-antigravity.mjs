#!/usr/bin/env node
// jev-antigravity: run Antigravity CLI (agy) through a local jev-gateway.
import { antigravity } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(antigravity);