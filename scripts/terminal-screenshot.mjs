// Replay the actual Pi PTY output in xterm.js and capture the terminal pixels.
// Optional QA dependencies are separate from Pair's runtime dependencies.
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [input,output,columns='80',rows='24']=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: terminal-screenshot.mjs input.ansi output.png [columns rows]');
const playwright=process.env.PAIR_PLAYWRIGHT ? await import(pathToFileURL(resolve(process.env.PAIR_PLAYWRIGHT)).href) : await import('playwright');
const xterm=process.env.PAIR_XTERM ?? resolve('node_modules/@xterm/xterm');
const browser=await playwright.chromium.launch({headless:true,...(process.env.PAIR_CHROMIUM?{executablePath:process.env.PAIR_CHROMIUM}:{})});
try{
  const page=await browser.newPage({viewport:{width:Number(columns)*10+40,height:Number(rows)*22+40},deviceScaleFactor:1});
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#101010}#terminal{width:max-content}</style><div id="terminal"></div>');
  await page.addStyleTag({content:readFileSync(join(xterm,'css/xterm.css'),'utf8')});
  await page.addScriptTag({path:join(xterm,'lib/xterm.js')});
  await page.evaluate(({cols,rows})=>{window.term=new window.Terminal({cols,rows,fontFamily:'Consolas, monospace',fontSize:14,lineHeight:1.15,cursorBlink:false,theme:{background:'#101010',foreground:'#d8d8d8'}});window.term.open(document.getElementById('terminal'));},{cols:Number(columns),rows:Number(rows)});
  await page.evaluate(data=>new Promise(resolve=>window.term.write(data,resolve)),readFileSync(resolve(input),'utf8'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.locator('#terminal').screenshot({path:resolve(output)});
  console.log(`Captured live Pi ANSI replay: ${output}`);
}finally{await browser.close();}
