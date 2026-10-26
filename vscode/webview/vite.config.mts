import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));

export default defineConfig(({mode})=>({
  define:{'process.env.NODE_ENV':JSON.stringify(mode==='production'?'production':'development')},
  root,plugins:[react()],base:'./',server:{host:'127.0.0.1',port:5173,strictPort:true},
  build:{outDir:resolve(root,'../media/ui'),emptyOutDir:true,sourcemap:false,cssCodeSplit:false,
    lib:{entry:resolve(root,'src/main.tsx'),name:'PairUI',formats:['iife'],fileName:()=> 'app.js'},
    rolldownOptions:{output:{assetFileNames:asset=>asset.name?.endsWith('.css')?'app.css':'[name][extname]'}}}
}));
