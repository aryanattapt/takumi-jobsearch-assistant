import { inject } from 'vitest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: inject('databaseUrl'),
  STORAGE_DIR: inject('storageDir'),
  APP_ORIGIN: 'http://localhost:3000',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  LOGIN_MAX_ATTEMPTS: '5',
  LOGIN_WINDOW_MINUTES: '15',
});
