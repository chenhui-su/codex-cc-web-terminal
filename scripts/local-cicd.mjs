import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");
const logsDir = path.join(root, "logs");
const logFile = path.join(logsDir, "local-cicd.log");
const pm2Script = path.join(root, "node_modules", "pm2", "bin", "pm2");

function now() {
  return new Date().toISOString();
}

function log(message) {
  const line = `${now()} ${message}`;
  console.log(line);
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, { env, capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0 && !allowFailure) {
    const stderr = String(result.stderr || "").trim();
    fail(`${command} ${args.join(" ")} failed with code ${result.status}: ${stderr}`);
  }

  return {
    status: result.status ?? 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function captureTrim(command, args, env) {
  return run(command, args, { env, capture: true }).stdout.trim();
}

function captureTrimOptional(command, args, env) {
  const result = run(command, args, { env, capture: true, allowFailure: true });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = {
    mode: "once",
    workBranch: process.env.LOCAL_CICD_WORK_BRANCH || "local-cicd",
    baseRemote: process.env.LOCAL_CICD_BASE_REMOTE || "origin",
    baseBranch: process.env.LOCAL_CICD_BASE_BRANCH || "main",
    publishRemote: process.env.LOCAL_CICD_PUBLISH_REMOTE || "fork",
    publishBranch: process.env.LOCAL_CICD_PUBLISH_BRANCH || "local-cicd",
    intervalSeconds: 300,
    proxy: process.env.LOCAL_CICD_PROXY || "http://127.0.0.1:10808",
    healthPort: 3210,
    testScript: "test:backend",
    skipTests: false,
    skipBuild: false,
    skipRestart: false
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) {
    options.mode = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--work-branch") {
      options.workBranch = args[index + 1] || options.workBranch;
      index += 1;
      continue;
    }

    if (arg === "--base-remote") {
      options.baseRemote = args[index + 1] || options.baseRemote;
      index += 1;
      continue;
    }

    if (arg === "--base-branch") {
      options.baseBranch = args[index + 1] || options.baseBranch;
      index += 1;
      continue;
    }

    if (arg === "--publish-remote") {
      const value = String(args[index + 1] || "").trim();
      options.publishRemote = value.toLowerCase() === "off" ? "" : value;
      index += 1;
      continue;
    }

    if (arg === "--publish-branch") {
      options.publishBranch = args[index + 1] || options.publishBranch;
      index += 1;
      continue;
    }

    if (arg === "--interval-seconds") {
      options.intervalSeconds = Number.parseInt(args[index + 1] || "", 10) || options.intervalSeconds;
      index += 1;
      continue;
    }

    if (arg === "--proxy") {
      const value = String(args[index + 1] || "").trim();
      options.proxy = value.toLowerCase() === "off" ? "" : value;
      index += 1;
      continue;
    }

    if (arg === "--health-port") {
      options.healthPort = Number.parseInt(args[index + 1] || "", 10) || options.healthPort;
      index += 1;
      continue;
    }

    if (arg === "--test-script") {
      options.testScript = args[index + 1] || options.testScript;
      index += 1;
      continue;
    }

    if (arg === "--skip-tests") {
      options.skipTests = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "--skip-restart") {
      options.skipRestart = true;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  if (!["once", "loop"].includes(options.mode)) {
    fail(`Unsupported mode: ${options.mode}`);
  }

  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 10) {
    fail("--interval-seconds must be an integer >= 10");
  }

  if (!options.workBranch) {
    fail("--work-branch is required");
  }

  if (!options.baseRemote || !options.baseBranch) {
    fail("--base-remote and --base-branch are required");
  }

  if (options.publishRemote && !options.publishBranch) {
    fail("--publish-branch is required when --publish-remote is enabled");
  }

  return options;
}

function buildEnv(options) {
  const env = { ...process.env };
  if (options.proxy) {
    env.HTTP_PROXY = options.proxy;
    env.HTTPS_PROXY = options.proxy;
    env.http_proxy = options.proxy;
    env.https_proxy = options.proxy;
  }
  return env;
}

function getWorktreeStatus(env) {
  const output = captureTrim("git", ["status", "--porcelain"], env);
  if (!output) {
    return { blocking: [], untracked: [] };
  }

  const blocking = [];
  const untracked = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith("?? ")) {
      untracked.push(line.slice(3));
      continue;
    }
    blocking.push(line);
  }

  return { blocking, untracked };
}

function changedFilesBetween(env, left, right) {
  const output = captureTrim("git", ["diff", "--name-only", `${left}..${right}`], env);
  if (!output) {
    return [];
  }
  return output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function waitForHealth(port, timeoutSeconds = 30) {
  const endpoint = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = await response.text();
        log(`[health] ok ${endpoint} ${body}`);
        return;
      }
    } catch {
      // keep retrying
    }

    await sleep(800);
  }

  fail(`health check did not pass in ${timeoutSeconds}s at ${endpoint}`);
}

function fetchRemote(env, remote, branch) {
  run("git", ["-c", "http.sslBackend=openssl", "fetch", remote, branch, "--prune"], { env });
}

function pushToFork(env, options) {
  if (!options.publishRemote) {
    return;
  }

  log(`[publish] push HEAD -> ${options.publishRemote}/${options.publishBranch}`);
  run(
    "git",
    [
      "-c",
      "http.sslBackend=openssl",
      "push",
      options.publishRemote,
      `HEAD:${options.publishBranch}`,
      "--force-with-lease"
    ],
    { env }
  );
}

async function deployCycle(options) {
  const env = buildEnv(options);
  const baseRef = `${options.baseRemote}/${options.baseBranch}`;

  const currentBranch = captureTrim("git", ["branch", "--show-current"], env);
  if (currentBranch !== options.workBranch) {
    fail(`current branch is ${currentBranch}; switch to ${options.workBranch} before running local CI/CD`);
  }

  const status = getWorktreeStatus(env);
  if (status.blocking.length > 0) {
    log(`[skip] tracked changes detected, skip this cycle: ${status.blocking.join(" | ")}`);
    return;
  }
  if (status.untracked.length > 0) {
    log(`[worktree] untracked files ignored: ${status.untracked.join(", ")}`);
  }

  log(`[git] fetch ${options.baseRemote}/${options.baseBranch}`);
  fetchRemote(env, options.baseRemote, options.baseBranch);

  if (options.publishRemote) {
    log(`[git] fetch ${options.publishRemote}/${options.publishBranch}`);
    const publishFetch = run(
      "git",
      ["-c", "http.sslBackend=openssl", "fetch", options.publishRemote, options.publishBranch, "--prune"],
      { env, allowFailure: true, capture: true }
    );
    if (publishFetch.status !== 0) {
      const message = (publishFetch.stderr || publishFetch.stdout || "unknown error").trim();
      log(`[warn] fetch ${options.publishRemote}/${options.publishBranch} failed: ${message}`);
    }
  }

  const oldHead = captureTrim("git", ["rev-parse", "HEAD"], env);
  const baseHead = captureTrim("git", ["rev-parse", baseRef], env);
  const mergeBase = captureTrim("git", ["merge-base", "HEAD", baseRef], env);

  if (mergeBase === baseHead) {
    log(`[sync] already based on latest ${baseRef} at ${baseHead.slice(0, 7)}`);

    if (options.publishRemote) {
      const publishRef = `${options.publishRemote}/${options.publishBranch}`;
      const publishHead = captureTrimOptional("git", ["rev-parse", publishRef], env);
      if (!publishHead || publishHead !== oldHead) {
        pushToFork(env, options);
      }
    }
    return;
  }

  log(`[sync] rebase ${options.workBranch} on ${baseRef} (${oldHead.slice(0, 7)} -> ${baseHead.slice(0, 7)})`);

  const rebaseResult = run("git", ["rebase", baseRef], { env, allowFailure: true, capture: true });
  if (rebaseResult.status !== 0) {
    run("git", ["rebase", "--abort"], { env, allowFailure: true });
    fail(`git rebase failed: ${rebaseResult.stderr || rebaseResult.stdout}`);
  }

  const newHead = captureTrim("git", ["rev-parse", "HEAD"], env);
  if (newHead === oldHead) {
    log(`[sync] branch unchanged at ${newHead.slice(0, 7)}`);
    return;
  }

  const changedFiles = changedFilesBetween(env, oldHead, newHead);

  if (changedFiles.includes("package.json") || changedFiles.includes("package-lock.json")) {
    log("[deps] package files changed, running npm ci");
    run("npm", ["ci", "--no-audit", "--no-fund"], { env });
  }

  if (!options.skipTests) {
    log(`[test] npm run ${options.testScript}`);
    run("npm", ["run", options.testScript], { env });
  }

  if (!options.skipBuild) {
    log("[build] npm run web:build");
    run("npm", ["run", "web:build"], { env });
  }

  if (!options.skipRestart) {
    if (!fs.existsSync(pm2Script)) {
      fail(`pm2 is not installed in node_modules: ${pm2Script}`);
    }
    log("[deploy] pm2 restart codex-cc-web-terminal --update-env");
    run(process.execPath, [pm2Script, "restart", "codex-cc-web-terminal", "--update-env"], { env });
    await waitForHealth(options.healthPort, 40);
  }

  pushToFork(env, options);
  log(`[deploy] completed at ${newHead.slice(0, 7)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === "once") {
    await deployCycle(options);
    return;
  }

  log(
    `[loop] started interval=${options.intervalSeconds}s workBranch=${options.workBranch} base=${options.baseRemote}/${options.baseBranch}`
  );

  while (true) {
    try {
      await deployCycle(options);
    } catch (error) {
      log(`[error] ${error?.message || String(error)}`);
    }
    await sleep(options.intervalSeconds * 1000);
  }
}

main().catch((error) => {
  log(`[fatal] ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});

