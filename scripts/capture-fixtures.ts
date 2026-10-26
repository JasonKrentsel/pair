import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createReviewComponent } from "../extensions/pair/review.ts";
import { fixtures, fixtureTheme } from "./fixtures.ts";
import { renderStepResult } from "../extensions/pair/history.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const out = resolve(process.argv[2] ?? "artifacts/ui");
mkdirSync(out,{recursive:true});
const captures: any[] = [];
for(const [cols,rows] of [[80,24],[110,36],[160,45],[38,12]]) {
  const theme = fixtureTheme();
  for(const [name, fixture] of Object.entries(fixtures)) {
    const tui: any = {terminal:{columns:cols,rows},requestRender(){}};
    const component = createReviewComponent({...fixture,tui,theme,done(){},onOpenExternal:async()=>{}});
    component.render(cols-4);
    for(const key of fixture.keys ?? []) {component.handleInput(key);component.render(cols-4);}
    const lines = component.render(cols-4);
    if(lines.some(line=>visibleWidth(line)>cols-4) || lines.length>rows) throw new Error(`Overflow: ${name} ${cols}x${rows}`);
    const id = `${name}-${cols}x${rows}`;
    const capture = {id,fixture:name,cols,rows,theme:"dark",pi:"1.4.0",state:component.state,lines,sha256:createHash("sha256").update(lines.join("\n")).digest("hex")};
    writeFileSync(resolve(out,id+".ansi"),lines.join("\r\n"));
    captures.push(capture);
    component.dispose();
  }
}
const theme = fixtureTheme();
for(const expanded of [false,true]) {
  const f = fixtures.multi;
  const result = {content:[{type:"text" as const,text:"Applied."}],details:{...f,status:"Applied"}};
  const lines = renderStepResult(result,{expanded,isPartial:false},theme,{outputPad:1,isError:false}).render(110);
  captures.push({id:`history-${expanded?"expanded":"collapsed"}`,fixture:"history",cols:110,rows:Math.max(24,lines.length+4),theme:"dark",lines});
}
writeFileSync(resolve(out,"captures.json"),JSON.stringify(captures));
console.log(`Captured ${captures.length} real component frames in ${out}`);
