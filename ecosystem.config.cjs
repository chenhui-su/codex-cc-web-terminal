const path = require("node:path");

const root = __dirname;
const logsDir = path.join(root, "logs");

const shared = {
  script: path.join(root, "src", "server.js"),
  cwd: root,
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  restart_delay: 1200,
  kill_timeout: 5000,
  listen_timeout: 5000,
  min_uptime: "5s",
  max_restarts: 20,
  out_file: path.join(logsDir, "pm2-out.log"),
  error_file: path.join(logsDir, "pm2-error.log"),
  merge_logs: true,
  time: true,
  env: {
    NODE_ENV: "production"
  }
};

module.exports = {
  apps: [
    {
      ...shared,
      name: "codex-cc-web-terminal",
      watch: false
    },
    {
      ...shared,
      name: "codex-cc-web-terminal-cicd",
      script: path.join(root, "scripts", "local-cicd.mjs"),
      args: [
        "loop",
        "--work-branch",
        "local-cicd",
        "--base-remote",
        "origin",
        "--base-branch",
        "main",
        "--publish-remote",
        "off",
        "--interval-seconds",
        "300",
        "--proxy",
        "http://127.0.0.1:10808",
        "--health-port",
        "3210"
      ],
      watch: false,
      out_file: path.join(logsDir, "pm2-cicd-out.log"),
      error_file: path.join(logsDir, "pm2-cicd-error.log"),
      env: {
        NODE_ENV: "production"
      }
    },
    {
      ...shared,
      name: "codex-cc-web-terminal-dev",
      watch: [path.join(root, "src"), path.join(root, "web"), path.join(root, ".env")],
      ignore_watch: [
        path.join(root, "data"),
        path.join(root, "logs"),
        path.join(root, "node_modules")
      ],
      env: {
        NODE_ENV: "development"
      }
    }
  ]
};
