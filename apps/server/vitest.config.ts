import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Never send real email, WhatsApp or paid Meta calls from tests, whatever the root .env holds.
  test: { fileParallelism: false, testTimeout: 15_000, env: { SMTP_URL: '', WA_ACCESS_TOKEN: '', META_API_KEY: '', PEXELS_API_KEY: '', RATE_LIMITS: 'off', BETA_APPROVAL: 'off', ALLOWLIST_ENABLED: 'true', ADMIN_EMAILS: 'admin@example.com', MS_CLIENT_ID: 'test-ms-client', MS_CLIENT_SECRET: 'test-ms-secret', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '', FACEBOOK_LOGIN_CONFIG_ID: '', MAIL_DEMO_USERS: '', MAIL_DEMO_MAILBOXES: '', APP_ENCRYPTION_KEY: 'test-encryption-key', UPLOAD_DIR: join(tmpdir(), 'ipersons-test-uploads') } },
});
