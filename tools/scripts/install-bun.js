#!/usr/bin/env node

const { execSync } = require("child_process")
const { packageManager } = require("../../package.json")

// package.json `packageManager` is the single source of truth for the bun version; CI reads the same
// pin, so a local install resolves bun.lock exactly as CI does.
const PINNED_VERSION = packageManager.replace(/^bun@/, "")

// The value is interpolated into a shell command below, so only a plain x.y.z may reach it.
if (!/^\d+\.\d+\.\d+$/.test(PINNED_VERSION)) {
  console.error(`❌ package.json packageManager must be bun@<major>.<minor>.<patch>, got "${packageManager}".`);
  process.exit(1);
}

function installedVersion() {
  try {
    return execSync("bun --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

// Plain numeric x.y.z comparison; a pre-release suffix is ignored.
function compareVersions(a, b) {
  const left = a.split(".").map((part) => parseInt(part, 10) || 0)
  const right = b.split(".").map((part) => parseInt(part, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

const installed = installedVersion()

if (installed !== null && compareVersions(installed, PINNED_VERSION) === 0) {
  console.log(`✅ Bun ${PINNED_VERSION} is already installed.`);
} else if (installed !== null && compareVersions(installed, PINNED_VERSION) > 0) {
  console.warn(`⚠️ Bun ${installed} is newer than the ${PINNED_VERSION} this repo pins. Leaving it alone; bun.lock may resolve differently from CI.`);
} else {
  console.log(installed === null
    ? `⚙️ Bun not found. Installing bun@${PINNED_VERSION} globally...`
    : `⚙️ Bun ${installed} is older than the ${PINNED_VERSION} this repo pins. Installing bun@${PINNED_VERSION} globally...`);
  try {
    execSync(`npm install -g bun@${PINNED_VERSION}`, { stdio: "inherit" });
  } catch (err) {
    console.error("❌ Failed to install Bun:", err.message);
    process.exit(1);
  }
  const after = installedVersion()
  if (after !== PINNED_VERSION) {
    console.error(`❌ Expected bun ${PINNED_VERSION} after install but found ${after === null ? "no bun on PATH" : after}. Check that the global npm bin directory comes first on PATH.`);
    process.exit(1);
  }
  console.log(`✅ Bun ${PINNED_VERSION} installed successfully.`);
}
