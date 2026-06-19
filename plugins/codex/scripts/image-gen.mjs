#!/usr/bin/env node

/**
 * Codex plugin — image generation via Codex's built-in $imagegen skill (gpt-image-2).
 *
 * Billing: routes through the ChatGPT subscription used by `codex login`
 * (auth_mode "chatgpt") — NO OPENAI_API_KEY, no per-image API charge. Image turns
 * consume the regular Codex usage limits (faster than normal turns).
 *
 * Invoked by the /codex:image slash command, which forwards the raw argument
 * string as a single token. Examples:
 *   node image-gen.mjs "a lobster in a suit, photorealistic"
 *   node image-gen.mjs "lecture poster --name poster --outdir ./assets"
 *
 * Under the hood this spawns:
 *   codex exec -C <outdir> -s workspace-write --skip-git-repo-check \
 *     "$imagegen <prompt>. Save as ./<file>.png"
 *
 * Design notes:
 * - `$imagegen` is Codex's built-in image skill. It is passed as a literal argv
 *   argument (no shell involved), so there is no `$`-variable expansion to escape.
 * - `-s workspace-write` keeps the sandbox ON (writes scoped to the working dir).
 *   image_gen is a native Codex tool call, not a sandboxed shell command, so the
 *   sandbox's network restriction does not block it — the nuclear
 *   `--dangerously-bypass-approvals-and-sandbox` flag is NOT needed.
 * - OPENAI_API_KEY is stripped from the child environment: if it were set, Codex
 *   would route image generation through the paid Images API instead of the
 *   subscription.
 * - Codex also saves a copy under ~/.codex/generated_images/<session>/; if the
 *   requested relative save did not land, we fall back to copying the newest file
 *   from there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";

const DEFAULT_OUTDIR = "generated";
const CODEX_IMAGES_DIR = path.join(os.homedir(), ".codex", "generated_images");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// Newest *.png under ~/.codex/generated_images modified at or after `since` (ms epoch).
function newestCodexImageSince(since) {
  if (!fs.existsSync(CODEX_IMAGES_DIR)) {
    return null;
  }
  let best = null;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.toLowerCase().endsWith(".png")) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime >= since && (!best || mtime > best.mtime)) {
          best = { path: full, mtime };
        }
      }
    }
  };
  try {
    walk(CODEX_IMAGES_DIR);
  } catch {
    // Ignore traversal errors and rely on whatever we found.
  }
  return best?.path ?? null;
}

function main() {
  const raw = process.argv[2] ?? "";
  const { options, positionals } = parseArgs(splitRawArgumentString(raw), {
    valueOptions: ["name", "outdir"]
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail('Usage: /codex:image "<prompt>" [--name <name>] [--outdir <dir>]');
  }

  const name = options.name ?? "image";
  const outdir = path.resolve(process.cwd(), options.outdir ?? DEFAULT_OUTDIR);
  fs.mkdirSync(outdir, { recursive: true });

  const fileName = `${name}_${timestamp()}.png`;
  const targetPath = path.join(outdir, fileName);

  // Passed as a literal argv argument — no shell, so `$imagegen` is not expanded.
  const codexPrompt =
    `$imagegen ${prompt}. ` +
    "Use the built-in image_gen tool — do not write any scripts and do not use an API key. " +
    `Save the resulting image as ./${fileName} in the working directory.`;

  // Strip OPENAI_API_KEY so Codex bills the ChatGPT subscription, not the paid API.
  const childEnv = { ...process.env };
  delete childEnv.OPENAI_API_KEY;

  const startedAt = Date.now();
  process.stderr.write(`Generating via Codex $imagegen (ChatGPT subscription) -> ${targetPath}\n`);

  const result = spawnSync(
    "codex",
    ["exec", "-C", outdir, "-s", "workspace-write", "--skip-git-repo-check", codexPrompt],
    { env: childEnv, encoding: "utf8" }
  );

  if (result.error) {
    fail(`Failed to launch codex: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-12).join("\n");
    fail(`codex exec exited with status ${result.status}.\n${detail}`);
  }

  // Prefer the file Codex was asked to save; otherwise grab its default-dir copy.
  let savedPath = fs.existsSync(targetPath) ? targetPath : null;
  if (!savedPath) {
    const fromCodexDir = newestCodexImageSince(startedAt);
    if (fromCodexDir) {
      fs.copyFileSync(fromCodexDir, targetPath);
      savedPath = targetPath;
    }
  }

  if (!savedPath) {
    fail(
      `Codex finished but no image file was found at ${targetPath} or under ${CODEX_IMAGES_DIR}.`
    );
  }

  process.stdout.write(`  [OK] ${savedPath}\n`);
}

main();
