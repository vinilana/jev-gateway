#!/usr/bin/env node
// Persistent setup for OpenCode Desktop. The global OpenCode config is shared with the CLI, so
// make only focused edits to the gateway model/provider and preserve the user's JSONC as written.
import { applyEdits, modify, parse } from "jsonc-parser";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

const PROVIDER_ID = "jev-gateway";
const APP_NAME = "OpenCode";
const BACKUP_HOME = join(homedir(), ".jev-gateway");

function configHome() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(source, providerId) {
  const errors = [];
  const parsed = source.trim() ? parse(source, errors, { allowTrailingComma: true }) : {};
  if (errors.length) throw new Error("OpenCode's config file has invalid JSON/JSONC; fix it before setting up the app.");
  if (!isObject(parsed)) throw new Error("OpenCode's config file must contain a JSON object.");
  for (const [key, value] of [["provider", parsed.provider], [providerId, parsed.provider?.[providerId]], ["options", parsed.provider?.[providerId]?.options], ["models", parsed.provider?.[providerId]?.models]]) {
    if (value !== undefined && !isObject(value)) throw new Error(`OpenCode config setting ${key} must be a JSON object.`);
  }
  return parsed;
}

/** Merge the gateway defaults without dropping existing JSONC comments or unrelated settings. */
export function mergeOpenCodeDesktopConfig(source, origin, route) {
  if (!route?.providerId?.trim() || !route?.modelId?.trim() || !route?.model?.trim()) {
    throw new Error("OpenCode provider and model IDs cannot be empty.");
  }
  const { providerId, modelId, model } = route;
  const startingText = source.trim() ? source : "{}\n";
  const parsed = validateConfig(startingText, providerId);
  const provider = parsed.provider?.[providerId];
  if (provider?.models?.[modelId] !== undefined && !isObject(provider.models[modelId])) {
    throw new Error(`OpenCode config model ${model} must be a JSON object.`);
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: newline };
  const updates = [
    [["$schema"], "https://opencode.ai/config.json"],
    [["model"], model],
    [["small_model"], model],
    [["provider", providerId, "options", "baseURL"], `${origin}/v1`],
  ];
  if (providerId === PROVIDER_ID) {
    updates.push(
      [["provider", providerId, "npm"], "@ai-sdk/openai-compatible"],
      [["provider", providerId, "name"], "Jev Gateway"],
      [["provider", providerId, "options", "apiKey"], `{env:${route.apiKeyEnv ?? "OPENAI_API_KEY"}}`],
      [["provider", providerId, "models", modelId, "name"], `Jev Gateway (${modelId})`],
    );
  }
  let text = startingText;
  for (const [path, value] of updates) text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  validateConfig(text, providerId);
  return { text, changed: text !== source };
}

function configPath() {
  const directory = configHome();
  const json = join(directory, "opencode.json");
  const jsonc = join(directory, "opencode.jsonc");
  const existing = [json, jsonc].filter(existsSync);
  if (existing.length > 1) throw new Error(`Both ${json} and ${jsonc} exist; keep one global config file, then retry.`);
  return existing[0] ?? json;
}

function writeAtomically(file, text, mode) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function configureOpenCodeDesktopApp(origin, route) {
  const directory = configHome();
  const file = configPath();
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const result = mergeOpenCodeDesktopConfig(before, origin, route);
  if (!result.changed) return { changed: false, configPath: file };

  mkdirSync(directory, { recursive: true });
  const backup = join(BACKUP_HOME, `opencode-config.before-app-setup${extname(file)}`);
  if (existed && !existsSync(backup)) {
    mkdirSync(BACKUP_HOME, { recursive: true });
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  }
  const mode = existed ? statSync(file).mode & 0o777 : 0o600;
  writeAtomically(file, result.text, mode);
  return { changed: true, configPath: file, backupPath: existed ? backup : undefined };
}

function exec(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true, ...options }).trim();
}

function launch(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function windowsApp(execCommand) {
  const script = [
    "$roots = @((Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'), (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'))",
    "$link = Get-ChildItem -Path $roots -Filter 'OpenCode.lnk' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if (-not $link) { throw 'OpenCode Desktop shortcut was not found.' }",
    "$shell = New-Object -ComObject WScript.Shell",
    "$app = $shell.CreateShortcut($link.FullName)",
    "@{target=$app.TargetPath;arguments=$app.Arguments;workingDirectory=$app.WorkingDirectory} | ConvertTo-Json -Compress",
  ].join("; ");
  const app = JSON.parse(execCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
  if (!app.target || !existsSync(app.target)) throw new Error("OpenCode Desktop executable was not found.");
  return app;
}

function windowsProcessCount(execCommand) {
  return Number(execCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name OpenCode -ErrorAction SilentlyContinue).Count",
  ]));
}

function closeWindowsApp(execCommand) {
  execCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }",
  ]);
}

async function restartOnWindows({ execCommand, launchProcess, wait }) {
  let app;
  try {
    app = windowsApp(execCommand);
  } catch (error) {
    return { restarted: false, reason: error.message };
  }
  const wasOpen = windowsProcessCount(execCommand) > 0;
  if (wasOpen) {
    closeWindowsApp(execCommand);
    for (let attempt = 0; attempt < 40 && windowsProcessCount(execCommand) > 0; attempt++) await wait(500);
    if (windowsProcessCount(execCommand) > 0) return { restarted: false, reason: "OpenCode Desktop did not close gracefully; it was left running." };
  }
  const payload = Buffer.from(JSON.stringify(app), "utf8").toString("base64");
  const script = `$app = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $startOptions = @{ FilePath = $app.target; PassThru = $true; ErrorAction = 'Stop' }; if ($app.arguments) { $startOptions.ArgumentList = $app.arguments }; if ($app.workingDirectory) { $startOptions.WorkingDirectory = $app.workingDirectory }; $started = Start-Process @startOptions; if (-not $started) { throw 'OpenCode Desktop did not start.' }; @{pid=$started.Id} | ConvertTo-Json -Compress`;
  execCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: process.env });
  for (let attempt = 0; attempt < 40 && windowsProcessCount(execCommand) === 0; attempt++) await wait(500);
  if (windowsProcessCount(execCommand) === 0) {
    return { restarted: false, wasOpen, reason: "OpenCode Desktop did not start; open it manually to load the new configuration." };
  }
  return { restarted: true, wasOpen };
}

function macAppIsRunning(execCommand) {
  try {
    execCommand("pgrep", ["-x", APP_NAME]);
    return true;
  } catch {
    return false;
  }
}

async function restartOnMac({ execCommand, launchProcess, wait }) {
  let appPath;
  try {
    appPath = execCommand("osascript", ["-e", `POSIX path of (path to application "${APP_NAME}")`]);
  } catch {
    return { restarted: false, reason: "OpenCode Desktop was not found in Applications." };
  }
  const executable = join(appPath, "Contents", "MacOS", APP_NAME);
  if (!existsSync(executable)) return { restarted: false, reason: "OpenCode Desktop executable was not found." };
  const wasOpen = macAppIsRunning(execCommand);
  if (wasOpen) {
    execCommand("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
    for (let attempt = 0; attempt < 40 && macAppIsRunning(execCommand); attempt++) await wait(500);
    if (macAppIsRunning(execCommand)) return { restarted: false, reason: "OpenCode Desktop did not quit gracefully; it was left running." };
  }
  await launchProcess(executable, [], { env: process.env });
  return { restarted: true, wasOpen };
}

/** Restart with the environment from setup; OpenCode resolves saved provider credentials itself. */
export async function restartOpenCodeDesktopApp(dependencies = {}) {
  const deps = {
    platform: process.platform,
    execCommand: exec,
    launchProcess: launch,
    wait: pause,
    ...dependencies,
  };
  if (deps.platform === "win32") return restartOnWindows(deps);
  if (deps.platform === "darwin") return restartOnMac(deps);
  return { restarted: false, reason: "Automatic OpenCode Desktop restart is not supported on this platform. Restart the app manually." };
}
