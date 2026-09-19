#!/usr/bin/env node
// jev-opencode: run OpenCode through a local jev-gateway. Nothing in ~/.config/opencode is modified.
import { opencode } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(opencode);
