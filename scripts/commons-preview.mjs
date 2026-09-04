import {build} from 'esbuild';import fs from 'node:fs';
const out=process.argv[2]||'dist/ANIMA_Sanctuary_3D.html';
const result=await build({entryPoints:['src/main.js'],outfile:'preview.js',bundle:true,format:'iife',target:'es2022',minify:true,write:false,legalComments:'inline'});
const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text.replace(/<\/script/gi,'<\\/script');
const css=result.outputFiles.find(f=>f.path.endsWith('.css')).text;
let html=fs.readFileSync('index.html','utf8').replace(/<script type="module"[^>]+><\/script>/,'').replace('</head>',()=>`<style>${css}</style></head>`).replace('</body>',()=>`<script>window.__ANIMA_STANDALONE__=true;${js}</script></body>`);
// No network resources are bundled by URL. Protocol-console links intentionally remain relative.
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(out,html);console.log(`${out}: ${Buffer.byteLength(html)} bytes`);
