// Development commands reuse Pi's installed peer dependencies without changing
// the extension's installation or adding another copy of the Pi runtime.
import { registerHooks } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.PI_PAIR_RUNTIME ?? join(homedir(),'.pi','agent','install','releases','1.4.0','node_modules');
const parentURL=pathToFileURL(join(resolve(root),'..','pair-runtime-resolver.mjs')).href;
registerHooks({resolve(specifier,context,nextResolve){
  try{return nextResolve(specifier,context);}catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND' || !(specifier.startsWith('@earendil-works/') || specifier==='typebox' || specifier.startsWith('typebox/')))throw error;
    return nextResolve(specifier,{...context,parentURL});
  }
}});
