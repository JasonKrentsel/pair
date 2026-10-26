import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerInteractiveTerminal} from '../extensions/pair/interactive-terminal.ts';
import {PairReviewBridge} from '../extensions/pair/bridge.ts';

test('PTY requires a one-use grant and accepts typed input only for the approved running command',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'pair-pty-test-')),bridge=new PairReviewBridge({registryDir:join(root,'registry')});let tool:any;
 const control=registerInteractiveTerminal({registerTool(t:any){tool=t;}} as any,bridge);
 await bridge.start(root);
 const command='[Console]::Write([char]27+"[32mCOLOR"+[char]27+"[0m`r`n"); $name=Read-Host "PAIR_INPUT"; Write-Output ("ANSWER="+$name); exit 0';
 try{
  await assert.rejects(tool.execute('x',{ticket:'invented',shell:'powershell',command}),/no current approval/);
  const r=bridge.publish({title:'Prompt test',why:'Exercise input',changes:[{label:command,kind:'powershell',command,interactive:true,added:0,removed:0}]},()=>{});
  bridge.decide({action:'approve'});
  const params=control.grant({root,reviewId:r.id,index:0,shell:'powershell',command,timeout:10});
  let sent=false;const updates:string[]=[];
  const result=await tool.execute('x',params,undefined,(partial:any)=>{
    const text=partial.content[0]?.text||'';updates.push(text);
    if(!sent && text.includes('PAIR_INPUT')){sent=true;const t=bridge.terminalState!;
      assert.throws(()=>bridge.terminalAction({...t,runId:'stale',action:'input',sequence:1,text:'wrong'}),/no longer/);
      bridge.terminalAction({...t,action:'resize',cols:100,rows:25});
      bridge.terminalAction({...t,action:'input',sequence:1,text:'PAIR_QA_INPUT\r'});
      assert.throws(()=>bridge.terminalAction({...t,action:'input',sequence:1,text:'duplicate'}),/stale/);
    }
  });
  assert.equal(sent,true);assert.equal(result.isError,false);assert.match(result.content[0].text,/ANSWER=PAIR_QA_INPUT/);assert.ok(updates.some(s=>s.includes('\x1b[')));assert.equal(bridge.terminalState,undefined);
  await assert.rejects(tool.execute('x',params),/no current approval/);
 }finally{await bridge.close();rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

for(const stopAction of ['stop','ctrl-c']) test('PTY '+stopAction+' interrupts the process and invalidated grants never execute',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'pair-pty-stop-')),bridge=new PairReviewBridge({registryDir:join(root,'registry')});let tool:any;
 const control=registerInteractiveTerminal({registerTool(t:any){tool=t;}} as any,bridge);await bridge.start(root);
 const command='Write-Output "WAITING"; Start-Sleep -Seconds 30';
 try{
  const r=bridge.publish({title:'Stop test',why:'Exercise stop',changes:[{label:command,kind:'powershell',command,interactive:true,added:0,removed:0}]},()=>{});bridge.decide({action:'approve'});
  const grant={root,reviewId:r.id,index:0,shell:'powershell',command,timeout:10};
  const expired=control.grant(grant);control.clear();await assert.rejects(tool.execute('x',expired),/no current approval/);
  let stopped=false;
  const result=await tool.execute('x',control.grant(grant),undefined,(partial:any)=>{if(!stopped && partial.content[0]?.text.includes('WAITING')){stopped=true;bridge.terminalAction({...bridge.terminalState,...(stopAction==='stop'?{action:'stop'}:{action:'input',sequence:1,text:'\x03'})});}});
  assert.equal(stopped,true);assert.equal(result.isError,true);assert.match(result.content[0].text,/interrupted/);assert.equal(bridge.terminalState,undefined);
 }finally{await bridge.close();rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
