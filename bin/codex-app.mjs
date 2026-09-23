#!/usr/bin/env node
// Setup helpers for the local Codex desktop app. Keep edits to config.toml scoped to the
// provider and default-provider keys that jev-gateway owns; the rest of the user's TOML stays put.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_ID = "jev-gateway";
const APP_NAME = "ChatGPT";
const CONFIG_HOME = join(homedir(), ".codex");
const CONFIG_PATH = join(CONFIG_HOME, "config.toml");
const BACKUP_PATH = join(homedir(), ".jev-gateway", "codex-config.before-app-setup.toml");
const PROVIDER_HEADER = `[model_providers.${PROVIDER_ID}]`;

function splitComment(text) {
  let quote = "";
  let triple = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && !triple && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && !triple && char === "\\") {
        escaped = true;
        continue;
      }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) {
        quote = "";
        triple = false;
        i += 2;
      } else if (!triple && char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      triple = text.slice(i, i + 3) === char.repeat(3);
      if (triple) i += 2;
    } else if (char === "#") {
      return { value: text.slice(0, i).trimEnd(), comment: text.slice(i) };
    }
  }
  return { value: text.trimEnd(), comment: "" };
}

function assignment(line, key) {
  const match = line.match(new RegExp(`^(\\s*)(?:${key}|"${key}"|'${key}')(\\s*=\\s*)(.*)$`));
  if (!match) return undefined;
  const { value, comment } = splitComment(match[3]);
  return { indent: match[1], separator: match[2], value: value.trim(), comment };
}

function setAssignment(lines, key, value, start, end) {
  const matches = [];
  for (let i = start; i < end; i++) if (assignment(lines[i], key)) matches.push(i);
  if (matches.length > 1) throw new Error(`config.toml has duplicate ${key} settings in one table`);
  if (matches.length === 1) {
    const index = matches[0];
    const current = assignment(lines[index], key);
    if (current.value === value) return false;
    lines[index] = `${current.indent}${key}${current.separator}${value}${current.comment ? ` ${current.comment}` : ""}`;
    return true;
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return true;
}

function firstTable(lines) {
  return lines.findIndex((line) => /^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line));
}

function providerTable(lines) {
  const header = /^\s*\[\s*model_providers\s*\.\s*(?:jev-gateway|"jev-gateway"|'jev-gateway')\s*\]\s*(?:#.*)?$/;
  const matches = [];
  for (let i = 0; i < lines.length; i++) if (header.test(lines[i])) matches.push(i);
  if (matches.length > 1) throw new Error(`config.toml has duplicate ${PROVIDER_HEADER} tables`);
  return matches.length ? matches[0] : -1;
}

function upsertCodexProvider(source, origin) {
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  let changed = false;
  const rootEnd = firstTable(lines);
  const end = rootEnd < 0 ? lines.length : rootEnd;
  changed = setAssignment(lines, "model_provider", `"${PROVIDER_ID}"`, 0, end) || changed;

  const values = {
    name: `"${PROVIDER_ID}"`,
    base_url: `"${origin}/v1"`,
    wire_api: `"responses"`,
    requires_openai_auth: "true",
  };
  let start = providerTable(lines);
  if (start < 0) {
    if (lines.length && lines.at(-1).trim()) lines.push("");
    start = lines.length;
    lines.push(PROVIDER_HEADER);
    for (const [key, value] of Object.entries(values)) lines.push(`${key} = ${value}`);
    changed = true;
  } else {
    let tableEnd = lines.findIndex((line, i) => i > start && /^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line));
    if (tableEnd < 0) tableEnd = lines.length;
    const tableLines = lines.slice(start + 1, tableEnd);
    for (const [key, value] of Object.entries(values)) {
      changed = setAssignment(tableLines, key, value, 0, tableLines.length) || changed;
    }
    lines.splice(start + 1, tableEnd - start - 1, ...tableLines);
  }

  return { text: `${lines.join("\n")}\n`, changed };
}

function writeAtomically(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

export function configureCodexDesktopApp(origin) {
  const existed = existsSync(CONFIG_PATH);
  const before = existed ? readFileSync(CONFIG_PATH, "utf8") : "";
  const result = upsertCodexProvider(before, origin);
  if (!result.changed) return { changed: false, configPath: CONFIG_PATH };

  mkdirSync(CONFIG_HOME, { recursive: true });
  if (existed && !existsSync(BACKUP_PATH)) {
    mkdirSync(dirname(BACKUP_PATH), { recursive: true });
    copyFileSync(CONFIG_PATH, BACKUP_PATH);
    chmodSync(BACKUP_PATH, 0o600);
  }
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  writeAtomically(CONFIG_PATH, result.text.replace(/\n/g, newline));
  return { changed: true, configPath: CONFIG_PATH, backupPath: existed ? BACKUP_PATH : undefined };
}

function exec(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true }).trim();
}

function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function windowsAppId() {
  return exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$app = Get-StartApps | Where-Object { $_.Name -eq 'ChatGPT' } | Select-Object -First 1; if ($app) { $app.AppID }",
  ]);
}

function windowsProcessCount() {
  return Number(exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue).Count",
  ]));
}

function closeWindowsApp() {
  exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }",
  ]);
}

async function restartOnWindows() {
  const appId = windowsAppId();
  if (!appId) return { restarted: false, reason: "Could not find ChatGPT in the Windows app list." };
  const wasOpen = windowsProcessCount() > 0;
  if (wasOpen) {
    closeWindowsApp();
    for (let attempt = 0; attempt < 40 && windowsProcessCount() > 0; attempt++) await pause(500);
    if (windowsProcessCount() > 0) return { restarted: false, reason: "ChatGPT did not close gracefully; it was left running." };
  }
  await launch("explorer.exe", [`shell:AppsFolder\\${appId}`]);
  return { restarted: true, wasOpen };
}

function macAppIsRunning() {
  try {
    exec("pgrep", ["-x", APP_NAME]);
    return true;
  } catch {
    return false;
  }
}

async function restartOnMac() {
  const wasOpen = macAppIsRunning();
  if (wasOpen) {
    exec("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
    for (let attempt = 0; attempt < 40 && macAppIsRunning(); attempt++) await pause(500);
    if (macAppIsRunning()) return { restarted: false, reason: "ChatGPT did not quit gracefully; it was left running." };
  }
  await launch("open", ["-a", APP_NAME]);
  return { restarted: true, wasOpen };
}

export async function restartCodexDesktopApp() {
  if (process.platform === "win32") return restartOnWindows();
  if (process.platform === "darwin") return restartOnMac();
  return { restarted: false, reason: "Automatic Codex app restart is not supported on this platform." };
}
