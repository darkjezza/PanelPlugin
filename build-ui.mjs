import { build } from 'esbuild';

await build({
  entryPoints: ['idle-stop/frontend/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  outfile: 'idle-stop/frontend/frontend.mjs',
  define: { 'process.env.NODE_ENV': '"production"' },
});

console.log('built idle-stop/frontend/frontend.mjs');
