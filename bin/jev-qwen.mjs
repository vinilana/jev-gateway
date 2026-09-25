#!/usr/bin/env node
import { qwen } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(qwen);
