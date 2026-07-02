module.exports = {
  apps: [
    {
      name: 'storage-api',
      script: 'src/index.js',
      cwd: __dirname,
      // Single instance only: the tus FileStore and the processing queue
      // are in-process — cluster mode would corrupt uploads.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
