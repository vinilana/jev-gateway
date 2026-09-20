#!/usr/bin/env node
// jev-gateway: one gateway for every tool. Start it once, switch it on inside the tools you use,
// and keep running `codex`, `claude`, `opencode` and `gemini` under their own names.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TOOLS, disable, disableAutostart, enable, enableAutostart, readState, shellFiles } from "./enable.mjs";
import { runLauncher } from "./launcher.mjs";

const gateway = {
  name: "jev-gateway",
  client: "gateway",
  portEnv: "JEV_GATEWAY_PORT",
  defaultPort: 8787,
  // Requests that come in without a tool prefix go here; each tool has an upstream of its own.
  upstream: () => process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1",
  upstreamHelp: "UPSTREAM_BASE_URL   where requests without a tool prefix go (default https://api.openai.com/v1)",
  configHelp: () => "Run `jev-gateway enable <tool>` instead.",
};
const origin = `http://127.0.0.1:${process.env.JEV_GATEWAY_PORT ?? gateway.defaultPort}`;
const names = Object.keys(TOOLS);

const HELP = `jev-gateway: one gateway for every coding agent

  jev-gateway enable <tool>…    start the gateway and switch it on inside a tool (${names.join(", ")})
  jev-gateway disable <tool>…   put the tool's configuration back as it was (or: disable --all)
  jev-gateway status            is the gateway running, and which tools go through it?
  jev-gateway start | stop      run or stop the background gateway
  jev-gateway autostart on|off  start the gateway with your shell, so an enabled tool never finds it down
  jev-gateway dashboard         open the monitoring dashboard
  jev-gateway routing on|off    off = baseline mode: stop asking Jev, keep counting tokens
  jev-gateway setup             choose where to reach Jev (TypeSafe, OpenRouter, Vercel) and set the key
  jev-gateway logs              follow routing decisions live

After \`enable\`, keep using the tool under its own name. Nothing else changes: your login, your
model and your other settings stay as they are, and \`disable\` undoes it.`;

/** The launcher already knows how to start, stop, watch and set up a gateway: hand those to it. */
const delegate = (...flags) => {
  process.argv = [process.argv[0], process.argv[1], ...flags];
  return runLauncher(gateway);
};

// Messages shared with the jev-<tool> launchers spell these as flags (`--setup`); both forms work here.
const [rawCommand, ...rest] = process.argv.slice(2);
const command = rawCommand?.replace(/^--/, "");
const pickTools = () => {
  const chosen = rest.includes("--all") ? names : rest.filter((name) => !name.startsWith("-"));
  const unknown = chosen.filter((name) => !TOOLS[name]);
  if (!chosen.length || unknown.length) {
    console.error(unknown.length ? `Unknown tool: ${unknown.join(", ")}. Choose from ${names.join(", ")}.` : `Which tool? Choose from ${names.join(", ")}.`);
    process.exit(1);
  }
  return chosen;
};

if (["start", "stop", "logs", "dashboard", "setup"].includes(command)) {
  await delegate(`--${command}`);
} else if (command === "routing") {
  await delegate("--routing", rest[0]);
} else if (command === "status") {
  await delegate("--status");
  const state = readState(process.env);
  const enabled = Object.keys(state);
  console.log(enabled.length ? `tools going through the gateway: ${enabled.map((name) => `${name} (${state[name].file})`).join(", ")}` : "tools going through the gateway: none yet, run `jev-gateway enable <tool>`");
} else if (command === "enable") {
  const tools = pickTools();
  // Key first, then a running gateway, and only then point a tool at it.
  await delegate("--start");
  for (const name of tools) {
    try {
      const { file, backup } = enable(name, origin);
      console.log(`${TOOLS[name].label}: enabled in ${file}${backup ? ` (original kept as ${backup})` : ""}`);
    } catch (error) {
      console.error(`${TOOLS[name].label}: not enabled. ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log("Use the tool under its own name. If the gateway is not running the tool cannot reach its model:");
  console.log("run `jev-gateway autostart on` to start it with your shell, or `jev-gateway disable <tool>` to go back.");
} else if (command === "disable") {
  const state = readState(process.env);
  const tools = rest.includes("--all") ? Object.keys(state) : pickTools();
  for (const name of tools) {
    const done = disable(name);
    console.log(done ? `${TOOLS[name].label}: ${done.file} is back as it was.` : `${TOOLS[name].label}: was not enabled.`);
  }
} else if (command === "autostart") {
  const on = rest[0] === "on";
  if (!on && rest[0] !== "off") {
    console.error("usage: jev-gateway autostart on|off");
    process.exit(1);
  }
  const files = shellFiles(process.env);
  if (!files.length) console.error("No ~/.bashrc or ~/.zshrc found. Start the gateway yourself with `jev-gateway start`.");
  for (const file of files) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, on ? enableAutostart(text) : disableAutostart(text));
    console.log(`${file}: autostart ${on ? "on" : "off"}`);
  }
} else {
  console.log(HELP);
  if (command && command !== "help" && command !== "--help") process.exitCode = 1;
}
