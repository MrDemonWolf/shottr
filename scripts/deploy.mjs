#!/usr/bin/env node
/**
 * Deploy with automatic CPU-limit fallback.
 *
 * `wrangler.toml` sets a hard per-request CPU cap (`[limits] cpu_ms`),
 * which the Cloudflare API only accepts on the paid Workers Standard
 * plan. This wrapper tries the full config first; if the API rejects
 * the limits block (Free plan), it retries once with `[limits]`
 * stripped so the deploy still succeeds — capped by the Free plan's
 * built-in 10 ms limit instead.
 *
 * Any extra CLI arguments are passed through to `wrangler deploy`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const passthroughArgs = process.argv.slice(2);

// Must live in the repo root so relative paths in the config (main,
// etc.) resolve the same way as for wrangler.toml.
const FALLBACK_CONFIG = join(root, "wrangler.nolimits.generated.toml");

function wranglerDeploy(extraArgs) {
  const result = spawnSync(
    "wrangler",
    ["deploy", ...extraArgs, ...passthroughArgs],
    { cwd: root, stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" },
  );
  if (result.error) {
    console.error(`Failed to run wrangler: ${result.error.message}`);
    console.error("Run via `bun run deploy` so node_modules/.bin is on PATH.");
    process.exit(1);
  }
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result;
}

/** Remove the `[limits]` section (header through next section header). */
function stripLimits(toml) {
  const out = [];
  let inLimits = false;
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[limits]") {
      inLimits = true;
      continue;
    }
    if (inLimits && trimmed.startsWith("[")) inLimits = false;
    if (!inLimits) out.push(line);
  }
  return out.join("\n");
}

const first = wranglerDeploy([]);
if (first.status === 0) process.exit(0);

const output = `${first.stdout ?? ""}${first.stderr ?? ""}`;
const limitsRejected = /limits|cpu_ms|paid plan/i.test(output);
if (!limitsRejected) process.exit(first.status ?? 1);

console.log(
  "\nCloudflare rejected the [limits] CPU cap (requires the paid " +
    "Workers Standard plan). Retrying without it — the Free plan's " +
    "built-in 10 ms cap applies instead.\n",
);

const toml = readFileSync(join(root, "wrangler.toml"), "utf8");
writeFileSync(FALLBACK_CONFIG, stripLimits(toml));
try {
  const second = wranglerDeploy(["--config", FALLBACK_CONFIG]);
  process.exit(second.status ?? 1);
} finally {
  rmSync(FALLBACK_CONFIG, { force: true });
}
