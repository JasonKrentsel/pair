// Paint the production component's captured ANSI rows. No UI layout is recreated
// here: this bridge translates terminal colors into pixels for visual inspection.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const folder = resolve(process.argv[2] ?? 'artifacts/ui');
const playwright = process.argv[3] ? await import(pathToFileURL(resolve(process.argv[3])).href) : await import('playwright');
const captures = JSON.parse(readFileSync(join(folder,'captures.json'),'utf8'));
const palette = ['#000000','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5','#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff'];
const color = n => n < 16 ? palette[n] : n < 232 ? `rgb(${[Math.floor((n-16)/36),Math.floor((n-16)/6)%6,(n-16)%6].map(v=>v?55+40*v:0).join(',')})` : `rgb(${[8+10*(n-232),8+10*(n-232),8+10*(n-232)].join(',')})`;
const escape = s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function ansi(line) {
  let foreground='#d8d8d8',background='transparent',bold=false,dim=false,underline=false;
  let html='',position=0;
  const span=text=>`<span style="color:${foreground};background:${background};font-weight:${bold?'bold':'normal'};opacity:${dim?'.65':'1'};text-decoration:${underline?'underline':'none'}">${escape(text)}</span>`;
  for(const match of line.matchAll(/\x1b\[([\d;]*)m|\x1b\][^\x07]*(?:\x07)|\x1b_[^\x07]*(?:\x07)/g)) {
    html+=span(line.slice(position,match.index)); position=match.index+match[0].length;
    if(match[1]===undefined)continue;
    const nums=(match[1]||'0').split(';').map(Number);
    for(let i=0;i<nums.length;i++) {
      const n=nums[i];
      if(n===0){foreground='#d8d8d8';background='transparent';bold=dim=underline=false;}
      else if(n===1)bold=true;else if(n===2)dim=true;else if(n===4)underline=true;
      else if(n===22){bold=false;dim=false;}else if(n===24)underline=false;
      else if(n===39)foreground='#d8d8d8';else if(n===49)background='transparent';
      else if((n===38||n===48)&&nums[i+1]===2){const rgb=`rgb(${nums.slice(i+2,i+5).join(',')})`;if(n===38)foreground=rgb;else background=rgb;i+=4;}
      else if((n===38||n===48)&&nums[i+1]===5){if(n===38)foreground=color(nums[i+2]);else background=color(nums[i+2]);i+=2;}
      else if(n>=30&&n<=37)foreground=color(n-30);else if(n>=90&&n<=97)foreground=color(n-90+8);
      else if(n>=40&&n<=47)background=color(n-40);else if(n>=100&&n<=107)background=color(n-100+8);
    }
  }
  return html+span(line.slice(position).replace(/\x1b[^\x20-\x7e]*/g,''));
}
const browser=await playwright.chromium.launch({headless:true,...(process.argv[4]?{executablePath:resolve(process.argv[4])}:{})});
try {
  const page=await browser.newPage({deviceScaleFactor:1});
  for(const capture of captures) {
    const rows=capture.lines.map(ansi).join('\n');
    const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#101010;color:#d8d8d8}pre{font-family:'Cascadia Mono','Consolas',monospace;font-size:14px;line-height:19px;font-variant-ligatures:none;margin:0;padding:20px;white-space:pre;width:max-content}.caption{font:12px sans-serif;color:#999;padding:12px 20px 0}</style><div class="caption">Pair component capture · ${escape(capture.id)} · Pi 1.4.0</div><pre>${rows}</pre>`;
    await page.setViewportSize({width:Math.max(400,Math.ceil(capture.cols*8.5+50)),height:Math.max(200,capture.rows*19+70)});
    await page.setContent(html);
    const dimensions=await page.locator('pre').boundingBox();
    await page.setViewportSize({width:Math.ceil(dimensions.width),height:Math.ceil(dimensions.y+dimensions.height)});
    await page.screenshot({path:join(folder,capture.id+'.png'),fullPage:true});
    writeFileSync(join(folder,capture.id+'.html'),html);
  }
} finally {await browser.close();}
writeFileSync(join(folder,'index.html'),`<!doctype html><meta charset="utf-8"><title>Pair review captures</title><style>body{font:16px system-ui;background:#161616;color:#ddd;margin:30px}img{max-width:100%;border:1px solid #444}a{color:#bda1ff}section{margin:40px 0}</style><h1>Pair review · production component captures</h1><p>Actual ANSI rows from the production renderer, painted for inspection. Live Pi interaction is checked separately.</p>${captures.map(c=>`<section><h2>${escape(c.id)}</h2><a href="${escape(c.id)}.ansi">ANSI source</a><p><img src="${escape(c.id)}.png"></p></section>`).join('')}`);
console.log(`Saved ${captures.length} PNGs and index.html`);
