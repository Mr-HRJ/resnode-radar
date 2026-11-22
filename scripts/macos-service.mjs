import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const LABEL = "com.resnode.radar.monitor";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const agentsDir = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(agentsDir, `${LABEL}.plist`);
const logDir = join(projectRoot, "logs");

export function buildLaunchAgentPlist({
  nodePath = process.execPath,
  workDir = projectRoot,
  port = 4173,
  intervalMinutes = 10
} = {}) {
  const daemonScript = join(workDir, "scripts/monitor-daemon.mjs");
  const outLog = join(workDir, "logs/daemon.out.log");
  const errLog = join(workDir, "logs/daemon.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonScript}</string>
    <string>--serve</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--interval</string>
    <string>${intervalMinutes}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
}

function runCli() {
  const action = process.argv[2] || "status";
  if (action === "install") {
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(plistPath, buildLaunchAgentPlist());
    try { execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); } catch {}
    execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
    console.log(`Installed and started macOS LaunchAgent: ${plistPath}`);
    console.log("ResNode Radar is now continuously monitored & served at http://127.0.0.1:4173/");
    return;
  }

  if (action === "uninstall") {
    if (existsSync(plistPath)) {
      try { execFileSync("launchctl", ["unload", "-w", plistPath], { stdio: "inherit" }); } catch {}
      rmSync(plistPath, { force: true });
      console.log(`Removed macOS LaunchAgent: ${plistPath}`);
    } else {
      console.log("LaunchAgent is not installed.");
    }
    return;
  }

  // status
  console.log(`LaunchAgent plist: ${existsSync(plistPath) ? `INSTALLED (${plistPath})` : "NOT INSTALLED"}`);
  try {
    const out = execFileSync("launchctl", ["list", LABEL], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    console.log(out.trim());
  } catch {
    console.log(`Service ${LABEL} is not currently loaded in launchctl.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
