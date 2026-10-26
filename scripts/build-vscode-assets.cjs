const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),modules=path.join(root,'vscode/node_modules'),out=path.join(root,'vscode/media/vendor');fs.mkdirSync(out,{recursive:true});
const files=[['@xterm/xterm/lib/xterm.js','xterm.js'],['@xterm/xterm/css/xterm.css','xterm.css'],['@xterm/addon-fit/lib/addon-fit.js','addon-fit.js'],['@highlightjs/cdn-assets/highlight.min.js','highlight.js'],['@highlightjs/cdn-assets/languages/powershell.min.js','powershell.js']];
for(const [source,target]of files)fs.copyFileSync(path.join(modules,source),path.join(out,target));
let licenses='Bundled third-party libraries: @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @highlightjs/cdn-assets 11.12.0.\n';
for(const pkg of ['@xterm/xterm','@xterm/addon-fit','@highlightjs/cdn-assets']){const dir=path.join(modules,pkg),name=fs.readdirSync(dir).find(f=>/^license(\.md|\.txt)?$/i.test(f));if(!name)throw Error('Missing license '+pkg);licenses+='\n'+pkg+'\n'+fs.readFileSync(path.join(dir,name),'utf8');}
fs.writeFileSync(path.join(out,'licenses.txt'),licenses);
