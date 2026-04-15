import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { Logger } from "../utils/logger.js";

type BootstrapResult = {
  hasXvfb: boolean;
  chromePath: string | null;
};

const isLinux = process.platform === "linux";
const AUTO_INSTALL_ENABLED = String(process.env.CF_BYPASS_AUTO_INSTALL || "true").toLowerCase() !== "false";

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "chrome",
];

const commandExists = (command: string): boolean => {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const probe = spawnSync("which", [command], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0;
};

const resolveCommandPath = (command: string): string | null => {
  const probe = spawnSync("which", [command], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const value = probe.stdout.trim();
  return value.length > 0 ? value : null;
};

const runLinuxInstall = (packages: string[]): boolean => {
  if (!isLinux || !AUTO_INSTALL_ENABLED) return false;
  if (!commandExists("apt-get")) return false;

  const sudoPrefix = typeof process.getuid === "function" && process.getuid() === 0
    ? []
    : commandExists("sudo")
      ? ["sudo"]
      : [];

  const run = (cmd: string, args: string[]) => {
    const proc = spawnSync(cmd, args, { stdio: "ignore" });
    return proc.status === 0;
  };

  const updateOk = run(sudoPrefix[0] || "apt-get", sudoPrefix.length ? ["apt-get", "update"] : ["update"]);
  if (!updateOk) return false;

  for (const pkg of packages) {
    const installOk = run(
      sudoPrefix[0] || "apt-get",
      sudoPrefix.length ? ["apt-get", "install", "-y", pkg] : ["install", "-y", pkg]
    );
    if (installOk) return true;
  }

  return false;
};

let bootstrapped: BootstrapResult | null = null;

export const ensureBrowserRuntime = (): BootstrapResult => {
  if (bootstrapped) return bootstrapped;

  let hasXvfb = commandExists("Xvfb");
  if (!hasXvfb && isLinux && AUTO_INSTALL_ENABLED) {
    Logger.warn("Xvfb is missing. Attempting automatic install...");
    if (runLinuxInstall(["xvfb"])) {
      hasXvfb = commandExists("Xvfb");
      if (hasXvfb) Logger.success("Installed Xvfb automatically.");
    }
  }

  let chromePath = (process.env.CHROME_PATH || "").trim();
  if (chromePath.length === 0 || !commandExists(chromePath)) {
    chromePath = "";
    for (const candidate of CHROME_CANDIDATES) {
      const resolved = resolveCommandPath(candidate);
      if (resolved) {
        chromePath = resolved;
        break;
      }
    }
  }

  if (!chromePath && isLinux && AUTO_INSTALL_ENABLED) {
    Logger.warn("Chrome/Chromium not found. Attempting automatic install...");
    runLinuxInstall(["chromium-browser", "chromium", "google-chrome-stable"]);

    for (const candidate of CHROME_CANDIDATES) {
      const resolved = resolveCommandPath(candidate);
      if (resolved) {
        chromePath = resolved;
        break;
      }
    }
  }

  if (chromePath) {
    process.env.CHROME_PATH = chromePath;
    Logger.info(`Using Chrome executable: ${chromePath}`);
  }

  bootstrapped = {
    hasXvfb,
    chromePath: chromePath || null,
  };

  return bootstrapped;
};
