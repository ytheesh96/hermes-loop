#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const lintArgs = ["lint", "--exclude-code-blocks", "docs"];
const direct = spawnSync("ascii-guard", lintArgs, { stdio: "inherit" });

if (!direct.error) {
  process.exit(direct.status ?? 1);
}

if (direct.error.code !== "ENOENT") {
  throw direct.error;
}

const viaUvx = spawnSync(
  "uvx",
  [
    "--from",
    "ascii-guard==2.3.0",
    "--with",
    "pyyaml==6.0.3",
    "ascii-guard",
    ...lintArgs,
  ],
  { stdio: "inherit" },
);

if (viaUvx.error?.code === "ENOENT") {
  console.error("ascii-guard is unavailable. Install it directly or install uv.");
  process.exit(127);
}

if (viaUvx.error) {
  throw viaUvx.error;
}

process.exit(viaUvx.status ?? 1);
