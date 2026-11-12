import { build } from 'esbuild';

await build({
  entryPoints: ['preview/office-viewer.js'],
  outfile: 'public/office-viewer.js',
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2022',
  legalComments: 'eof'
});
