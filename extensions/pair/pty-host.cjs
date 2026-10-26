'use strict';
// Each approved PTY has its own Node process so native terminal handles cannot
// keep Pi alive after command completion or escape a session shutdown.
const {spawn}=require('node-pty');
let pty,finished=false,stopping=false,exitTimer;
const send=value=>{if(process.connected)process.send(value);};
function finish(code,reason){if(finished)return;finished=true;clearTimeout(exitTimer);send({type:'exit',code,reason});setTimeout(()=>process.exit(0),20);}
function stop(reason){if(stopping||finished)return;stopping=true;try{pty?.kill();}catch{}exitTimer=setTimeout(()=>finish(-1,reason),1500);}
process.on('message',message=>{
 try{
  if(message.type==='start' && !pty){
   pty=spawn(message.file,message.args,{name:'xterm-256color',cols:120,rows:30,cwd:message.cwd,env:{...process.env,TERM:'xterm-256color'},useConpty:true,useConptyDll:true});
   pty.onData(text=>send({type:'data',text}));
   pty.onExit(event=>finish(event.exitCode,stopping?'Interactive command interrupted. Remaining actions were not run.':undefined));
   send({type:'ready'});
  }else if(message.type==='input' && !stopping)pty?.write(message.text);
  else if(message.type==='resize' && !stopping)pty?.resize(message.cols,message.rows);
  else if(message.type==='stop')stop(message.reason);
 }catch(error){finish(-1,String(error));}
});
process.on('disconnect',()=>stop('Pi disconnected.'));
process.on('uncaughtException',error=>{try{pty?.kill();}catch{}finish(-1,String(error));});
