import {CommerceClient} from '../dist/index.js';
// Deliberately local. No payment is submitted.
const client=new CommerceClient({transport:{async send(request){
 console.log(request.method,request.path);
 if(request.operation==='registerMerchant')return {status:201,body:{id:'merchant_demo'}};
 return {status:201,body:{id:'session_demo',status:'not_ready_for_payment'}};
}}});
console.log(await client.merchant.register({merchantName:'Northstar Demo',merchantUrl:'https://northstar.example',indicator:'ACG'}));
console.log(await client.checkout.acp.create({items:[{id:'sku_mug',quantity:1}]}));
