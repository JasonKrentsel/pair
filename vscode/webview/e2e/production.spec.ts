import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import type {PairState,UiMessage} from '../src/types';

const extensionRoot=resolve(__dirname,'../..');
const requireFromExtension=createRequire(resolve(extensionRoot,'package.json'));
const {renderWebview}=requireFromExtension('./webview.cjs') as {renderWebview(options:{state:PairState;assets:Record<string,string>;cspSource:string}):string};
const origin='https://pair.test';
const assets={'app.js':`${origin}/app.js`,'app.css':`${origin}/app.css`};

function initialState():PairState {
  return {
    version:'production-test',session:{sessionId:'production-session',root:'C:/work/greeting'},sessionsCount:1,
    connected:true,busy:false,trusted:true,canDecide:true,canApprove:true,dirtyFiles:[],alteredSnapshots:0,errorMessage:'',
    selectedIndex:0,conversationAvailable:true,actionConversations:[],conversationBusy:false,
    review:{id:'production-review',revision:7,fingerprint:'exact-reviewed-content',gate:19,title:'Preserve the reply contract',why:'Update only the greeting formatter.',pending:true,status:'Awaiting permission',changes:[{
      label:'src/greet.ts',kind:'Edit',before:'return name;',after:'return name.trim() || "friend";',added:1,removed:1,why:'Trim whitespace while preserving the public return type.',
    }]},
  };
}

async function production(page:Page) {
  const state=initialState(),errors:string[]=[],requests:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const html=renderWebview({state,assets,cspSource:origin});
  await page.route(`${origin}/**`,route=>{
    const pathname=new URL(route.request().url()).pathname;
    requests.push(pathname);
    if(pathname==='/') return route.fulfill({status:200,contentType:'text/html',body:html});
    if(pathname==='/app.js'||pathname==='/app.css')return route.fulfill({status:200,contentType:pathname.endsWith('.js')?'text/javascript':'text/css',body:readFileSync(resolve(extensionRoot,'media/ui',pathname.slice(1)))});
    return route.fulfill({status:404,body:'Unexpected production resource'});
  });
  await page.addInitScript(({state})=>{
    type Harness={messages:UiMessage[];violations:string[];state:PairState;local:unknown};
    const harness:Harness={messages:[],violations:[],state,local:undefined};
    const global=window as unknown as {__PAIR_PRODUCTION__:Harness;acquireVsCodeApi:()=>unknown};
    global.__PAIR_PRODUCTION__=harness;
    document.addEventListener('securitypolicyviolation',event=>harness.violations.push(`${event.violatedDirective}: ${event.blockedURI}`));
    global.acquireVsCodeApi=()=>({
      getState:()=>harness.local,setState:(value:unknown)=>{harness.local=value;},
      postMessage:(message:UiMessage)=>{
        harness.messages.push(structuredClone(message));
        if(message.action==='chat-action') {
          const review=harness.state.review!;
          harness.state={...harness.state,activeConversationId:'production-chat',actionConversations:[{
            id:'production-chat',reviewId:review.id,revision:review.revision,fingerprint:review.fingerprint,gate:review.gate,
            index:Number(message.index),status:'idle',messages:[],
          }]};
          window.postMessage({type:'pair-state',state:harness.state},'*');
        }
      },
    });
  },{state});
  await page.goto(origin);
  return {state,errors,requests};
}

const messages=(page:Page)=>page.evaluate(()=>(window as unknown as {__PAIR_PRODUCTION__:{messages:UiMessage[]}}).__PAIR_PRODUCTION__.messages);

test('production bundle excludes preview fixtures and Node environment reads',()=>{
  const source=readFileSync(resolve(extensionRoot,'media/ui/app.js'),'utf8');
  for(const marker of ['process.env','__PAIR_PREVIEW__','0.11.0-preview','Give empty names a friendly greeting','preview-step','createPreview','pair-ui-preview:','localhost:','127.0.0.1:'])expect(source,`Unexpected production marker: ${marker}`).not.toContain(marker);
});

test('packaged React mounts under its real CSP and sends exact decisions without implicit chat sends',async({page})=>{
  const {state,errors,requests}=await production(page);
  await expect(page.getByRole('heading',{name:'Preserve the reply contract',exact:true})).toBeVisible();
  await expect.poll(async()=>(await messages(page)).some(message=>message.action==='webview-ready')).toBe(true);
  await expect(page.locator('.pair-app')).toHaveAttribute('data-view','step');
  expect(await page.evaluate(()=>typeof (window as unknown as {process?:unknown}).process)).toBe('undefined');
  await page.getByRole('button',{name:'Approve step',exact:true}).click();
  const approval=(await messages(page)).find(message=>message.action==='approve')!;
  expect(approval.identity).toEqual({reviewId:state.review!.id,revision:7,fingerprint:'exact-reviewed-content',gate:19});
  expect((await messages(page)).filter(message=>message.action==='approve')).toHaveLength(1);

  await page.getByRole('button',{name:'Chat about greet.ts',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toBeVisible();
  await expect(page.locator('.pair-app')).toHaveAttribute('data-view','chat');
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Explain this without changing it.');
  const chat=(await messages(page)).find(message=>message.action==='chat-action')!;
  expect(chat.identity).toEqual(approval.identity);expect(chat.index).toBe(0);
  expect(chat.text).toBeUndefined();expect(chat.mode).toBeUndefined();
  expect((await messages(page)).filter(message=>message.action==='conversation-send')).toHaveLength(0);
  expect(await page.evaluate(()=>(window as unknown as {__PAIR_PRODUCTION__:{violations:string[]}}).__PAIR_PRODUCTION__.violations)).toEqual([]);
  expect(errors).toEqual([]);
  expect(requests.filter(path=>path!=='/favicon.ico').sort()).toEqual(['/','/app.css','/app.js']);
});
