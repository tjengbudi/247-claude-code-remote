import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read version from package.json at build time
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const APP_VERSION = pkg.version;

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // Inject version at build time for auto-update system
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  // Standalone output for Docker self-host
  output: 'standalone',
  // Required for monorepo: point to workspace root for correct file tracing
  outputFileTracingRoot: join(__dirname, '../../'),
  // Force-include dynamic imports and runtime files that file tracing may miss
  outputFileTracingIncludes: {
    // better-sqlite3 ships a native .node binary the tracer misses for prebuilt
    // deps; without it the standalone Docker image throws "Could not locate the
    // bindings file" on first DB use. drizzle/** ships the migration SQL files
    // read via fs at runtime (not import-detected by the tracer).
    '/*': [
      './node_modules/better-sqlite3/**',
      './drizzle/**',
    ],
  },
};

export default nextConfig;
