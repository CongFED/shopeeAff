module.exports = {
  apps: [
    {
      name: 'shopee-affiliate',
      script: 'dist/src/index.js',
      cwd: '/var/www/shopeeAff',
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
