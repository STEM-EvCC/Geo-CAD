import * as esbuild from 'esbuild';
import fs from 'fs';
const r = await esbuild.build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', platform: 'browser', loader: { '.wasm': 'binary' }, external: ['node:*'], minify: process.argv.includes('--min'), write: false, target: 'es2020', legalComments: 'eof' });
let js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync('template.html', 'utf8').replace('/*BUNDLE*/', () => js);
fs.writeFileSync('../index.html', html);
console.log('built', (html.length / 1024).toFixed(0) + ' KB', r.warnings.length ? r.warnings.map(w => w.text).join('; ') : '');
