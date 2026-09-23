// Shared by the jev-<client> launchers: keep one background router per client alive, then run
// the client pointed at it. Nothing in the client's own config directory is ever modified.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredProvider, loadProviders, runSetup, terminalIo } from "./setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(homedir(), ".jev-gateway");
// A git checkout runs the TypeScript sources directly; an installed package only ships dist/.
const FROM_SOURCE = existsSync(join(ROOT, "src/index.ts"));
const ROUTER_ARGS = FROM_SOURCE ? ["--import", "tsx", join(ROOT, "src/index.ts")] : [join(ROOT, "dist/index.js")];
/** Where the key for Jev and tuning knobs may live; the first file to set a variable wins. */
// (JEV_SKIP_PROJECT_ENV keeps a checkout's own .env out of it, so tests see a clean machine.)
const ENV_FILES = [...(FROM_SOURCE && !process.env.JEV_SKIP_PROJECT_ENV ? [join(ROOT, ".env")] : []), join(STATE_DIR, ".env")];

/**
 * @param {object} spec
 * @param {string} spec.name         launcher name, e.g. "jev-claude"
 * @param {string} spec.client       binary to run, e.g. "claude"; also names the log/pid files
 * @param {string} spec.portEnv      env var overriding the router port
 * @param {number} spec.defaultPort
 * @param {() => string} spec.upstream        where this client's traffic is forwarded
 * @param {string} spec.upstreamHelp          help text describing the upstream default
 * @param {(origin: string) => string[]} [spec.args]   extra leading arguments for the client
 * @param {(origin: string) => Record<string, string>} [spec.env]  extra environment for the client
 * @param {(origin: string) => string} spec.configHelp  how to wire the client up permanently
 * @param {string} [spec.appLabel] friendly desktop app name, e.g. "Codex desktop app"
 * @param {(origin: string, context?: any) => {changed: boolean, configPath: string, backupPath?: string}} [spec.setupApp] configure the desktop app
 * @param {() => any} [spec.setupAppPreflight] resolve prerequisites and setup context before starting the gateway
 * @param {() => Promise<{restarted: boolean, wasOpen?: boolean, reason?: string}>} [spec.restartApp] restart the desktop app
 */
/** Load the key for Jev and friends; real environment variables win over both files. */
export function loadEnv() {
  for (const file of ENV_FILES) if (existsSync(file)) process.loadEnvFile(file);
}

/** How to start a gateway process from this install: `spawn(process.execPath, GATEWAY_ARGS, { cwd: ROOT })`. */
export { ROOT, ROUTER_ARGS as GATEWAY_ARGS };

export async function runLauncher(spec) {
  loadEnv();

  const port = Number(process.env[spec.portEnv] ?? spec.defaultPort);
  const origin = `http://127.0.0.1:${port}`;
  const logFile = join(STATE_DIR, `${spec.client}.log`);
  const pidFile = join(STATE_DIR, `${spec.client}.pid`);
  const appLabel = spec.appLabel ?? `${spec.client} desktop app`;
  const appSetupHelp = spec.setupApp
    ? `  ${spec.name} --setup-app      configure ${appLabel}, start gateway, and restart it (Windows/macOS)\n`
    : "";

  const help = `${spec.name}: ${spec.client} with tool selection routed through Jev

  ${spec.name} [${spec.client} args]    start the gateway if needed, then run ${spec.client} through it
  ${spec.name} --dashboard        open the monitoring dashboard in your browser
  ${spec.name} --routing on|off   off = baseline mode: stop asking Jev, keep counting tokens
  ${spec.name} --status           is the gateway running, and where does it forward to?
  ${spec.name} --logs             follow routing decisions live (use a second terminal)
  ${spec.name} --start            start the gateway without opening ${spec.client}
  ${spec.name} --stop             stop the background gateway
  ${spec.name} --setup            choose where to reach Jev (TypeSafe, OpenRouter, Vercel) and set the key
${appSetupHelp}  ${spec.name} --print-config     how to point plain \`${spec.client}\` at the gateway permanently
  ${spec.name} --gateway-help     this text (\`--help\` shows ${spec.client}'s own help)

Environment (or ${ENV_FILES.at(-1)}):
  A key for Jev is required. ${spec.name} asks for it the first time and saves it; it can be
  TYPESAFE_API_KEY, OPENROUTER_API_KEY or AI_GATEWAY_API_KEY (JEV_PROVIDER picks when several are set)
  ${spec.portEnv}   router port for ${spec.client} (default ${spec.defaultPort})
  ${spec.upstreamHelp}
  BROWSER            command --dashboard opens the page with; "none" only prints the URL
`;

  const health = async () => {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };

  const tailLog = (lines = 15) =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "";

  const providers = loadProviders(ROOT);
  const envFile = ENV_FILES.at(-1);

  /** Ask for the key and adopt the answer in this process, so the gateway it starts inherits it. */
  const setup = async () => {
    let saved;
    try {
      saved = await runSetup({ name: spec.name, providers, envFile, io: terminalIo() });
    } catch {
      console.error(`\n${spec.name}: setup cancelled.`);
      process.exit(130);
    }
    if (!saved) process.exit(1);
    Object.assign(process.env, saved);
  };

  /** No key, no routing. With a person at the keyboard, ask; otherwise say exactly what is missing. */
  const ensureKey = async () => {
    if (configuredProvider(process.env, providers)) return;
    if (process.stdin.isTTY && process.stdout.isTTY) return setup();
    const names = Object.values(providers).map((provider) => provider.keyEnv).join(", ");
    console.error(`${spec.name}: no API key for Jev. Run \`${spec.name} --setup\` in a terminal, or set one of ${names} (environment or ${envFile}).`);
    process.exit(1);
  };

  const ensureRouter = async () => {
    const upstream = spec.upstream().replace(/\/+$/, "");
    const running = await health();
    if (running) {
      if (running.upstream === upstream) return;
      console.error(`${spec.name}: router on :${port} forwards to ${running.upstream}, expected ${upstream}.`);
      console.error(`${" ".repeat(spec.name.length)}  Run \`${spec.name} --stop\` and try again.`);
      process.exit(1);
    }
    await ensureKey();

    mkdirSync(STATE_DIR, { recursive: true });
    const log = openSync(logFile, "a");
    // The client authenticates itself (subscription login or its own key); the gateway must not swap that out.
    const { UPSTREAM_API_KEY: _key, ROUTER_API_KEY: _routerKey, ...env } = process.env;
    const child = spawn(process.execPath, ROUTER_ARGS, {
      cwd: ROOT,
      // JEV_LOG_FILE is where stdout goes (below): the router replays it so the dashboard keeps its history.
      env: { ...env, PORT: String(port), UPSTREAM_BASE_URL: upstream, JEV_CLIENT: spec.client, JEV_LOG_FILE: logFile },
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    writeFileSync(pidFile, String(child.pid));

    let exited = false;
    child.once("exit", () => (exited = true));
    for (let attempt = 0; attempt < 50 && !exited; attempt++) {
      if (await health()) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    console.error(`${spec.name}: the router did not start. Last log lines (${logFile}):\n${tailLog()}`);
    process.exit(1);
  };

  // Pid files written before the project was renamed; a router started back then is still running.
  const legacyPidFile = join(homedir(), ".jev-router", `${spec.client}.pid`);

  const stopRouter = async () => {
    // Whoever answers on the port is the router to stop; pid files only cover ones that don't say.
    const candidates = [(await health())?.pid];
    for (const file of [pidFile, legacyPidFile]) {
      if (existsSync(file)) candidates.push(Number(readFileSync(file, "utf8")));
      rmSync(file, { force: true });
    }
    const pids = [...new Set(candidates.filter((pid) => Number.isInteger(pid) && pid > 0))];
    let stopped = false;
    for (const pid of pids) {
      try {
        process.kill(pid);
        stopped = true;
        console.log(`${spec.name}: stopped router (pid ${pid}).`);
      } catch {
        // Already gone.
      }
    }
    if (!stopped) console.log(`${spec.name}: no router was running.`);
  };

  /** Whichever opener this platform has; under WSL the browser lives on the Windows side. */
  const openBrowser = async (url) => {
    const wsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
    const openers = [
      ...(process.env.BROWSER ? [[process.env.BROWSER, url]] : []),
      ...(process.platform === "darwin" ? [["open", url]] : []),
      ...(process.platform === "win32" ? [["cmd", "/c", "start", "", url]] : []),
      ...(wsl ? [["wslview", url], ["cmd.exe", "/c", "start", "", url]] : []),
      ["xdg-open", url],
    ];
    for (const [command, ...args] of openers) {
      const started = await new Promise((done) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.once("error", () => done(false));
        child.once("spawn", () => (child.unref(), done(true)));
      });
      if (started) return;
    }
  };

  // Only names neither client uses: `--help` and `--config` stay theirs, so those two are spelled
  // differently here. The original `--jev-*` spellings still work.
  const LEGACY = { "--jev-config": "--print-config", "--jev-help": "--gateway-help" };
  const [first] = process.argv.slice(2);
  const flag = LEGACY[first] ?? first?.replace(/^--jev-(?=dashboard$|routing$|status$|logs$|start$|stop$)/, "--");
  if (flag === "--gateway-help") return console.log(help);
  if (flag === "--setup") {
    if (!process.stdin.isTTY) return console.error(`${spec.name}: --setup asks questions, so it needs a terminal.`);
    await setup();
    // A gateway that is already running read the old key when it started.
    if (await health()) {
      await stopRouter();
      console.log(`${spec.name}: the gateway will start with the new key the next time you run ${spec.name}.`);
    }
    return;
  }
  if (flag === "--setup-app") {
    if (!spec.setupApp) return console.error(`${spec.name}: --setup-app is not available for ${spec.client}.`);
    let setupContext;
    try {
      setupContext = await spec.setupAppPreflight?.();
    } catch (error) {
      process.exitCode = 1;
      return console.error(`${spec.name}: ${error.message}. No ${appLabel} configuration was changed.`);
    }
    await ensureRouter();
    let configured;
    try {
      configured = await spec.setupApp(origin, setupContext);
    } catch (error) {
      process.exitCode = 1;
      return console.error(`${spec.name}: could not configure ${appLabel}: ${error.message}`);
    }
    console.log(`${spec.name}: ${appLabel} configuration ${configured.changed ? "updated" : "already points to the gateway"} in ${configured.configPath}.`);
    if (setupContext?.providerId && setupContext?.upstream) {
      const credential = setupContext.credentialSource === "opencode-auth-store" ? "the saved OpenCode API credential" : "OPENAI_API_KEY";
      console.log(`${spec.name}: ${setupContext.providerId} requests will use ${credential} and route to ${setupContext.upstream}.`);
    }
    if (configured.backupPath) console.log(`${spec.name}: previous config saved to ${configured.backupPath}.`);
    try {
      const restarted = await spec.restartApp?.();
      if (restarted?.restarted) {
        console.log(restarted.wasOpen ? `${spec.name}: restarted the ${appLabel}.` : `${spec.name}: opened the ${appLabel}.`);
      } else {
        process.exitCode = 1;
        console.error(`${spec.name}: ${restarted?.reason ?? `could not restart ${appLabel}.`} Restart it manually to load the configuration.`);
      }
    } catch (error) {
      process.exitCode = 1;
      console.error(`${spec.name}: configuration and gateway are ready, but ${appLabel} could not be restarted: ${error.message}`);
    }
    return;
  }
  if (flag === "--stop") return await stopRouter();
  if (flag === "--routing") {
    const wanted = process.argv[3];
    if (wanted !== "on" && wanted !== "off") return console.error(`usage: ${spec.name} --routing on|off`);
    await ensureRouter();
    const key = process.env.ROUTER_API_KEY ? `&key=${encodeURIComponent(process.env.ROUTER_API_KEY)}` : "";
    const response = await fetch(`${origin}/dashboard/routing?enabled=${wanted === "on"}${key}`, { method: "POST" });
    if (!response.ok) return console.error(`${spec.name}: the router refused (${response.status}). Run \`${spec.name} --stop\` and try again.`);
    return console.log(
      wanted === "on"
        ? `${spec.name}: routing on. Jev decides again.`
        : `${spec.name}: routing off (baseline mode). Requests go straight to the LLM, tokens are still metered.`,
    );
  }
  if (flag === "--print-config") return console.log(spec.configHelp(origin));
  if (flag === "--start") {
    await ensureRouter();
    return console.log(`${spec.name}: router up on ${origin} → ${spec.upstream()} (logs: ${logFile})`);
  }
  if (flag === "--status") {
    const running = await health();
    const via = running?.jev ? `, Jev via ${providers[running.jev]?.label ?? running.jev}` : "";
    console.log(running ? `${spec.name}: router up on ${origin} → ${running.upstream}${via}` : `${spec.name}: router is not running`);
    const configured = configuredProvider(process.env, providers);
    console.log(configured ? `key: ${providers[configured].label} (${providers[configured].keyEnv})` : `key: none yet, run \`${spec.name} --setup\``);
    return console.log(`logs: ${logFile}`);
  }
  if (flag === "--dashboard") {
    await ensureRouter();
    // `localhost`, not 127.0.0.1: it is the name WSL forwards to a browser running on Windows.
    const base = `http://localhost:${port}/dashboard`;
    // The page looks for the other launchers' routers on their default ports; tell it about moved ones.
    const peers = Object.entries(process.env).flatMap(([name, value]) => (/^JEV_[A-Z]+_PORT$/.test(name) && value !== String(port) ? [value] : []));
    const url = peers.length ? `${base}?peers=${peers.join(",")}` : base;
    const served = await fetch(url).then((response) => response.ok, () => false);
    if (!served) {
      console.error(`${spec.name}: the router on :${port} predates the dashboard. Run \`${spec.name} --stop\` and try again.`);
      process.exit(1);
    }
    console.log(`${spec.name}: dashboard at ${url}`);
    if (process.env.BROWSER !== "none") await openBrowser(url);
    return;
  }
  if (flag === "--logs") {
    mkdirSync(STATE_DIR, { recursive: true });
    closeSync(openSync(logFile, "a"));
    return spawn("tail", ["-n", "30", "-f", logFile], { stdio: "inherit" });
  }

  await ensureRouter();
  const child = spawn(spec.client, [...(spec.args?.(origin) ?? []), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ...spec.env?.(origin) },
  });
  child.on("error", (error) => {
    console.error(`${spec.name}: could not run ${spec.client}: ${error.message}`);
    process.exit(127);
  });
  // The router is left running for the next session; `--stop` ends it.
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  // Ctrl-C reaches the client directly (same foreground process group); it decides what that means.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
