/**
 * PM2 Ecosystem Configuration
 * 
 * Starts Trajectos V1 with 3 services: monitor, worker, watchdog
 * 
 * Usage:
 *   pm2 start ecosystem.config.js          # Start all services
 *   pm2 start ecosystem.config.js --only monitor  # Start only monitor
 *   pm2 restart all                         # Restart all services
 *   pm2 stop all                            # Stop all services
 *   pm2 status                              # Check status
 *   pm2 logs worker                         # View worker logs
 *   pm2 monit                               # Real-time monitoring
 */

module.exports = {
  apps: [
    // Monitor Service: Observability, healthchecks, metrics
    {
      name: 'monitor',
      script: './node_modules/.bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'cluster',
      cwd: './',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        LOG_LEVEL: 'INFO',
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      listen_timeout: 10000,
      kill_timeout: 5000,
      wait_ready: true,
      max_memory_restart: '512M',
      error_file: './logs/monitor-error.log',
      out_file: './logs/monitor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      namespace: 'trajectos',
    },

    // Worker Service: Main allocation pipeline
    {
      name: 'worker',
      script: './node_modules/.bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'cluster',
      cwd: './',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        LOG_LEVEL: 'INFO',
        REGIME_ENGINE_DEBUG: 'false',
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      listen_timeout: 10000,
      kill_timeout: 5000,
      wait_ready: true,
      max_memory_restart: '512M',
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      namespace: 'trajectos',
    },

    // Watchdog Service: Background jobs (TTL expiration, cleanup, state validation)
    {
      name: 'watchdog',
      script: './scripts/watchdog.js',
      instances: 1,
      exec_mode: 'fork',
      cwd: './',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'INFO',
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      kill_timeout: 5000,
      max_memory_restart: '256M',
      error_file: './logs/watchdog-error.log',
      out_file: './logs/watchdog-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      namespace: 'trajectos',
    },
  ],

  // Global settings for all apps
  deploy: {
    production: {
      user: 'root',
      host: process.env.DEPLOY_HOST || 'localhost',
      ref: 'origin/main',
      repo: 'git@github.com:your-org/trajectos.git',
      path: '/var/www/trajectos',
      'post-deploy':
        'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-deploy-local': 'echo "Deploying to production..."',
    },
  },

  // Graceful shutdown behavior
  shutdown_with_message: true,

  // Clustering options
  cluster_mode: {
    ready_boost: 1000,
  },
};
