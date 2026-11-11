import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommerceClient, completeApprovedCheckout, InMemoryAttemptStore,
  CartChangedError, UnknownOutcomeError, reconcileCheckout, waitForCatalog, FeedFailedError,
  AttemptConflictError } from '../dist/index.js';

const cart = {id:'s1',status:'ready_for_payment',currency:'USD',line_items:[],totals:[{type:'total',amount:1000}],fulfillment_options:[],messages:[],links:[]};
const order = {...cart,status:'completed'};
const payment = {payment_data:{token:'opaque',provider:'test'}};
function fixture(change=false, lose=false) {
  let reads=0, writes=0;
  const client=new CommerceClient({transport:{async send(r) {
    if(r.operation==='getCheckoutSession') return {status:200,body:{...cart,totals:[{type:'total',amount:change&&reads++>0?2000:1000}]}};
    writes++;
    if(lose) throw Error('connection lost');
    return {status:200,body:order};
  }}});
  const store=new InMemoryAttemptStore();
  return {client,store,writes:()=>writes,options:{client,store,scope:'merchant_1',attemptId:'a1',sessionId:'s1',payment,approve:async()=>true}};
}
test('approved checkout is submitted once and completed attempt is cached',async()=>{
 const f=fixture();await completeApprovedCheckout(f.options);await completeApprovedCheckout(f.options);assert.equal(f.writes(),1);
});
test('changed quote blocks order submission',async()=>{
 const f=fixture(true);await assert.rejects(completeApprovedCheckout(f.options),CartChangedError);assert.equal(f.writes(),0);
});
test('approval callback cannot mutate the retained quote',async()=>{
 const f=fixture();await completeApprovedCheckout({...f.options,approve:async(c:any)=>{c.totals=[];return true;}});assert.equal(f.writes(),1);
});
test('consumer rejection blocks completion',async()=>{
 const f=fixture();await assert.rejects(completeApprovedCheckout({...f.options,approve:async()=>false}),/declined/);assert.equal(f.writes(),0);
});
test('concurrent completions share one atomic attempt claim',async()=>{
 const f=fixture();const results=await Promise.allSettled([completeApprovedCheckout(f.options),completeApprovedCheckout(f.options)]);
 assert.equal(f.writes(),1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('lost completion response requires reconciliation instead of resubmission',async()=>{
 const f=fixture(false,true);await assert.rejects(completeApprovedCheckout(f.options),UnknownOutcomeError);
 await assert.rejects(completeApprovedCheckout(f.options),UnknownOutcomeError);assert.equal(f.writes(),1);
 await reconcileCheckout(f.store,'merchant_1','a1',async()=>order as any);
 assert.equal((await completeApprovedCheckout(f.options)).status,'completed');assert.equal(f.writes(),1);
});
test('attempt ID cannot be reused for a different payment',async()=>{
 const f=fixture();await completeApprovedCheckout(f.options);
 await assert.rejects(completeApprovedCheckout({...f.options,payment:{payment_data:{token:'different',provider:'test'}}}),AttemptConflictError);
});
test('reconciliation rejects an unrelated order',async()=>{
 const f=fixture(false,true);await assert.rejects(completeApprovedCheckout(f.options));
 await assert.rejects(reconcileCheckout(f.store,'merchant_1','a1',async()=>({...order,id:'other'}) as any),/does not match/);
});
test('catalog waits for protocol syndication after ingestion completes',async()=>{
 let n=0;const c=new CommerceClient({transport:{async send(){n++;return {status:200,body:{status:'COMPLETED',syndication:{acp:{status:n===1?'PENDING':'SUCCESS'}}}};}}});
 await waitForCatalog(c,'job',{protocols:['acp'],intervalMs:1});assert.equal(n,2);
});
test('partially rejected feed is not marked ready',async()=>{
 const c=new CommerceClient({transport:{async send(){return {status:200,body:{status:'COMPLETED',processing:{failureCount:1}}};}}});
 await assert.rejects(waitForCatalog(c,'job',{protocols:[]}),FeedFailedError);
});
test('catalog polling honors cancellation',async()=>{
 const c=new CommerceClient({transport:{async send(){throw Error('must not call');}}});
 const ac=new AbortController();ac.abort();await assert.rejects(waitForCatalog(c,'job',{protocols:[],signal:ac.signal}),{name:'AbortError'});
});
