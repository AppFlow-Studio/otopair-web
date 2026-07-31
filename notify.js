#!/usr/bin/env node
/**
 * notify.js — tiny, dependency-free desktop notification helper.
 *
 * Purpose (assumed — adjust if you meant something else): this session involved
 * repeatedly waiting on long-running background enrichment runs. This lets you
 * (or a hook) fire a desktop notification when a run finishes instead of
 * watching the terminal.
 *
 * Usage:
 *   node notify.js "Batch-9 enrichment finished"
 *   node notify.js "Deploy done" "otopair"        # message, title
 *   SomeLongCommand && node notify.js "done" || node notify.js "FAILED"
 *
 * As a Claude Code Stop hook (settings.json), so you're pinged when the agent
 * finishes a turn:
 *   { "hooks": { "Stop": [ { "hooks": [
 *       { "type": "command", "command": "node notify.js \"Claude finished\"" }
 *   ] } ] } }
 *
 * No external dependencies. Windows → PowerShell toast (BurntToast-free, uses
 * the built-in Windows.UI.Notifications). macOS → osascript. Linux →
 * notify-send. Everything falls back to a printed line + terminal bell so it
 * never fails a pipeline.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const os = require("node:os");

const message = process.argv[2] || "Task finished";
const title = process.argv[3] || "otopair";

/** Console fallback: always runs so the notification is never silent-lost. */
function consoleFallback() {
  // \x07 is the terminal bell.
  process.stdout.write(`\x07[notify] ${title}: ${message}\n`);
}

/** Escape a string for embedding inside a single-quoted PowerShell literal. */
function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

function notifyWindows() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName('text')
  $texts.Item(0).AppendChild($template.CreateTextNode('${psQuote(title)}')) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode('${psQuote(message)}')) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('otopair').Show($toast)
} catch {
  # Fall back to a message box if the toast runtime isn't available.
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('${psQuote(message)}', '${psQuote(title)}') | Out-Null
}
`.trim();
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

function notifyMac() {
  const r = spawnSync("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ], { stdio: "ignore" });
  return r.status === 0;
}

function notifyLinux() {
  const r = spawnSync("notify-send", [title, message], { stdio: "ignore" });
  return r.status === 0;
}

function main() {
  let ok = false;
  try {
    const platform = os.platform();
    if (platform === "win32") ok = notifyWindows();
    else if (platform === "darwin") ok = notifyMac();
    else ok = notifyLinux();
  } catch {
    ok = false;
  }
  // Always print the fallback line too — cheap, and guarantees a visible signal
  // in CI / headless contexts where the OS notifier is a no-op.
  consoleFallback();
  // Never fail the pipeline: a notifier that can't pop a toast still exits 0.
  process.exit(0);
}

main();
