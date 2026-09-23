#!/usr/bin/env node
import { kilo } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(kilo);
