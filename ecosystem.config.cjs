module.exports = {
  apps: [
    {
      name: 'x402go-api',
      cwd: '/var/www/x402go/backend',
      script: 'dist/server.js',
      interpreter: '/home/pilot/.bun/bin/bun',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '500M',
      kill_timeout: 70000,
    },
  ],
};
