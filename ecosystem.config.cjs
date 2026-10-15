module.exports = {
  apps: [
    {
      name: "x402go-api",
      cwd: "/var/www/x402go/backend",
      script: "src/server.ts",
      interpreter: "/home/pilot/.bun/bin/bun", // absolute path: pm2's boot PATH won't include ~/.bun
      env: { NODE_ENV: "production" },
      max_memory_restart: "500M",
      kill_timeout: 70000, // let in-flight settlements finish before SIGKILL
    },
  ],
};