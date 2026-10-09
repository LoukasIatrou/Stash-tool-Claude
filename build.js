import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const watch = process.argv.includes('--watch');

// Static files that are copied verbatim into dist/.
const STATIC = [
  'manifest.json',
  'content/pin-button.css',
  'content/sidebar/sidebar.css',
];

function copyStatics() {
  for (const file of STATIC) {
    const dest = path.join('dist', file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }

  // Icons directory.
  fs.mkdirSync('dist/icons', { recursive: true });
  for (const name of fs.readdirSync('icons')) {
    fs.copyFileSync(path.join('icons', name), path.join('dist/icons', name));
  }
}

const ctx = await esbuild.context({
  entryPoints: [
    'background/service-worker.js',
    'content/index.js',
  ],
  bundle:    true,
  format:    'esm',  // keeps "type":"module" in manifest valid
  outbase:   '.',    // mirrors source layout: dist/background/..., dist/content/...
  outdir:    'dist',
  sourcemap: watch ? 'inline' : false,
  minify:    !watch,
  logLevel:  'info',
});

if (watch) {
  copyStatics();
  await ctx.watch();
  console.log('[Stash] Watching for changes — load dist/ in chrome://extensions');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  copyStatics();
  console.log('[Stash] Build complete → dist/');
  console.log('[Stash] To package: Compress-Archive dist -DestinationPath stash-v2.zip');
}
