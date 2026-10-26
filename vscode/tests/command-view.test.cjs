const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {commandMarkup,validProgress,outputMarkup,outputScript}=require('../command-view.cjs');
test('command code preserves quotes and indentation while rendering hostile output as text',()=>{
 const html=commandMarkup('node -e "one & two"\n  echo <script>');
 assert.match(html,/<code>node -e &quot;one &amp; two&quot;<\/code>/);
 assert.match(html,/<code>  echo &lt;script&gt;<\/code>/);
 assert.ok(!outputMarkup(0,{text:'</pre><script>alert(1)</script>',status:'Running'}).includes('<script>'));
 new vm.Script(outputScript);
});
test('stream messages are restricted to command actions in this review',()=>{
 const review={id:'r',changes:[{command:'npm test'},{}]}, item={reviewId:'r',index:0,status:'Running',text:'hello',truncated:false};
 assert.equal(validProgress([item],review),true);
 for(const bad of [{...item,reviewId:'old'},{...item,index:1},{...item,text:'x'.repeat(32769)},{...item,status:'Approved'}])assert.equal(validProgress([bad],review),false);
 assert.equal(validProgress([item,item],review),false);
});
test('live output replaces text, preserves paused scroll and ignores another review',()=>{
 const pre={textContent:'',scrollTop:0,scrollHeight:400,clientHeight:100,addEventListener(k,fn){this[k]=fn;}}, button={addEventListener(k,fn){this[k]=fn;},setAttribute(){}}, status={},note={};
 const box={querySelector(s){return s==='pre'?pre:s==='[data-follow]'?button:s==='[data-output-status]'?status:note;}};
 let receive;
 vm.runInNewContext(outputScript,{identity:{reviewId:'r'},document:{querySelectorAll:()=>[box],querySelector:()=>box},window:{addEventListener:(_k,fn)=>receive=fn}});
 const update=(text,reviewId='r')=>receive({data:{type:'command-output',reviewId,progress:[{index:0,status:'Running',text}]}});
 update('one');update('one\ntwo');assert.equal(pre.textContent,'one\ntwo');
 pre.scrollTop=10;pre.scroll();update('one\ntwo\nthree');assert.equal(pre.scrollTop,10);
 update('wrong','other');assert.equal(pre.textContent,'one\ntwo\nthree');
 button.click();assert.equal(pre.scrollTop,400);
});
