import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./extension/manifest.json',import.meta.url)));
const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const shared={bundle:true,format:'iife',platform:'browser',target:'chrome125',minify:true,legalComments:'eof'};
await build({...shared,entryPoints:['src/worker.js','src/dashboard.js'],outdir:'extension'});
await build({...shared,define:{XW_EXTENSION_ID:JSON.stringify(id)},entryPoints:['src/signer.js'],outfile:'connector/signer.js'});
