const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  format: 'cjs',
  sourcemap: true,
  external: [
    // Keep native modules external
    '@prisma/client',
    'prisma',
    // Node built-ins
    'fs',
    'path',
    'crypto',
    'http',
    'https',
    'stream',
    'url',
    'util',
    'events',
    'buffer',
    'querystring',
    'os',
    'child_process',
    'net',
    'tls',
    'zlib',
    'dns',
    'tty',
    'assert',
    'async_hooks',
    'worker_threads',
    'perf_hooks',
    // OpenTelemetry modules that have native bindings
    '@opentelemetry/api',
  ],
}).then(() => {
  console.log('Build complete');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
