#!/usr/bin/env node
import { kiro } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(kiro);
