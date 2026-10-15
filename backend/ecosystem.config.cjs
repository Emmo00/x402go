module.exports = {
  apps: [
    {
      name: "x402go-api",
      cwd: "/var/www/x402go/backend",
      script: "src/server.ts",
      interpreter: "/home/deploy/.bun/bin/bun", // absolute path: pm2's boot PATH won't include ~/.bun
      env: { NODE_ENV: "production", PORT: 3000 },
      max_memory_restart: "500M",
      kill_timeout: 70000, // let in-flight settlements finish before SIGKILL
    },
  ],
};