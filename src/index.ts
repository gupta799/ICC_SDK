import contracts from './contracts.json' with { type: 'json' };
import type { Operations } from './generated.js';
export type { Operations } from './generated.js';
export type Operation = keyof Operations;
export interface Request { operation: Operation; method: string; path: string; body?: unknown; headers: Record<string,string>; query: Record<string,string|number>; signal?: AbortSignal }
export interface Response { status: number; body: unknown; headers?: Record<string,string> }
/** Must authenticate and encrypt requests and decrypt responses. Never pass bare fetch here for live ICC. */
export interface Transport { send(request: Request): Promise<Response> }
export interface EvidenceSink { record(event: {operation: Operation; status: number; outcome: string}): Promise<void> }
export interface CallOptions { path?: Record<string,string>; headers?: Record<string,string>; query?: Record<string,string|number>; signal?: AbortSignal }
export interface Result<T> { kind: 'success'|'action_required'|'accepted'|'unverified'; status: number; data: T }
export class ValidationError extends Error { constructor(public issues: string[]) { super(issues.join('; ')); this.name='ValidationError'; } }
export class ApiError extends Error { constructor(public status: number, public reason?: string) { super(`ICC request failed (${status})`); this.name='ApiError'; } }
export class UnknownOutcomeError extends Error { constructor(public operation: Operation) { super(`Outcome unknown for ${operation}; reconcile before retrying`); this.name='UnknownOutcomeError'; } }
type Schema = {type?:string; properties?:Record<string,Schema>; required?:string[];items?:Schema;enum?:unknown[];minItems?:number;maxItems?:number;minLength?:number;maxLength?:number;minimum?:number;maximum?:number;pattern?:string;allOf?:Schema[]};
function validate(s: Schema, value: unknown, path='$', issues:string[]=[]): string[] {
 if(s.allOf) for(const part of s.allOf) validate(part,value,path,issues);
 if(s.enum && !s.enum.includes(value)) issues.push(`${path}: unsupported value`);
 const type=s.type;
 if(type==='object') {
  if(!value || typeof value!=='object'||Array.isArray(value)){issues.push(`${path}: expected object`);return issues;}
  const v=value as Record<string,unknown>;
  for(const key of s.required??[])if(v[key]===undefined)issues.push(`${path}.${key}: required`);
  for(const [key,sub] of Object.entries(s.properties??{}))if(v[key]!==undefined)validate(sub,v[key],`${path}.${key}`,issues);
 } else if(type==='array') {
  if(!Array.isArray(value)){issues.push(`${path}: expected array`);return issues;}
  if(value.length<(s.minItems??0)||value.length>(s.maxItems??Infinity))issues.push(`${path}: invalid array size`);
  if(s.items)value.forEach((v,i)=>validate(s.items!,v,`${path}[${i}]`,issues));
 } else if(type==='string') {
  if(typeof value!=='string'){issues.push(`${path}: expected string`);return issues;}
  if(value.length<(s.minLength??0)||value.length>(s.maxLength??Infinity))issues.push(`${path}: invalid length`);
  if(s.pattern){let pattern=s.pattern,flags='';if(pattern.startsWith('(?s)')){pattern=pattern.slice(4);flags='s';}if(!new RegExp(pattern,flags).test(value))issues.push(`${path}: invalid format`);}
 } else if(type==='number'||type==='integer') {
  if(typeof value!=='number'||!Number.isFinite(value)||(type==='integer'&&!Number.isInteger(value))||value<(s.minimum??-Infinity)||value>(s.maximum??Infinity))issues.push(`${path}: invalid number`);
 } else if(type==='boolean'&&typeof value!=='boolean')issues.push(`${path}: expected boolean`);
 return issues;
}
export function validateRequest(operation:Operation,body:unknown):void {
 const schema=contracts[operation].body;
 if(schema){const errors=validate(schema as Schema,body);if(errors.length)throw new ValidationError(errors);}
 if(operation==='registerMerchant') {const b=body as Record<string,unknown>;if(b.paymentPayloadType==='ENCRYPTED'&&!b.encryptionKey)throw new ValidationError(['$.encryptionKey: required for ENCRYPTED delivery']);}
}
export class CommerceClient {
 private transport:Transport; private evidence?:EvidenceSink;
 constructor(options:{transport:Transport;evidence?:EvidenceSink}) {this.transport=options.transport;this.evidence=options.evidence;}
 async call<N extends Operation>(operation:N,body:Operations[N]['body'],options:CallOptions={}):Promise<Result<Operations[N]['response']>> {
  validateRequest(operation,body);
  const contract=contracts[operation];
  const path=contract.path.replace(/\{([^}]+)\}/g,(_,key:string)=>{const v=options.path?.[key];if(!v)throw new ValidationError([`path.${key}: required`]);return encodeURIComponent(v);});
  const headers={...options.headers};
  if(operation==='completeCheckout'||operation==='ucpCompleteCheckout') {
   const key=Object.entries(headers).find(([k])=>k.toLowerCase()==='idempotency-key')?.[1];
   if(!key?.trim())throw new ValidationError(['Idempotency-Key: required for order completion']);
  }
  options.signal?.throwIfAborted();
  let response:Response;
  try {response=await this.transport.send({operation,method:contract.method,path,body,headers,query:options.query??{},signal:options.signal});}
  catch {if(contract.method!=='GET')throw new UnknownOutcomeError(operation);throw new ApiError(0,'TRANSPORT_ERROR');}
  if(response.status<200||response.status>=300){const b=response.body as {reason?:unknown};throw new ApiError(response.status,typeof b?.reason==='string'?b.reason:undefined);}
  let kind:Result<unknown>['kind']='success';
  if(operation==='retrievePaymentCredentials')kind='unverified';
  else if(response.status===202)kind=['submitProductFeedJson','confirmTransactionEvents'].includes(operation)?'accepted':'action_required';
  // Audit failures cannot turn an already completed mutation into an apparent transport failure.
  if(this.evidence)try{await this.evidence.record({operation,status:response.status,outcome:kind});}catch{/* Caller owns monitoring of its evidence sink. */}
  return {kind,status:response.status,data:response.body as Operations[N]['response']};
 }
 merchant = {
  register:(body:Operations['registerMerchant']['body'])=>this.call('registerMerchant',body),
  get:(merchantId:string)=>this.call('getMerchant',undefined,{path:{merchantId}}),
  update:(merchantId:string,body:Operations['updateMerchant']['body'])=>this.call('updateMerchant',body,{path:{merchantId}})
 };
 catalog = {
  submit:(body:Operations['submitProductFeedJson']['body'])=>this.call('submitProductFeedJson',body),
  status:(jobId:string)=>this.call('getFeedJobStatus',{}, {path:{jobId}}),
  list:(page=0,size=300)=>this.call('getAllProducts',{}, {query:{page,size}})
 };
 checkout = {
  acp:{create:(body:Operations['createCheckoutSession']['body'],options?:CallOptions)=>this.call('createCheckoutSession',body,options),
   complete:(sessionId:string,body:Operations['completeCheckout']['body'],idempotencyKey:string)=>this.call('completeCheckout',body,{path:{session_id:sessionId},headers:{'Idempotency-Key':idempotencyKey}})},
  ucp:{create:(body:Operations['ucpCreateCheckoutSession']['body'],options?:CallOptions)=>this.call('ucpCreateCheckoutSession',body,options),
   complete:(sessionId:string,body:Operations['ucpCompleteCheckout']['body'],idempotencyKey:string)=>this.call('ucpCompleteCheckout',body,{path:{session_id:sessionId},headers:{'idempotency-key':idempotencyKey}})}
 };
}
/** Adapts configured official CyberSource API instances (JWT and MLE enabled).
 * Instances use a dedicated ApiClient per tenant to avoid shared singleton configuration.
 * Does not log payment data or retry mutations. */
export class OfficialClientTransport implements Transport {
 private apis:Partial<Record<Operation,object>>;
 constructor(apis:Partial<Record<Operation,object>>) {this.apis=apis;}
 async send(request:Request):Promise<Response> {
  const api=this.apis[request.operation] as Record<string,Function>|undefined;
  const fn=api?.[request.operation];if(!fn)throw new Error('Missing configured official API instance');
  const meta=contracts[request.operation];
  const pathValues:Record<string,string>={};
  const segments=meta.path.split('/');request.path.split('/').forEach((v,i)=>{const match=segments[i]?.match(/^\{(.+)\}$/);if(match)pathValues[match[1]]=decodeURIComponent(v);});
  const args:unknown[]=[];const opts:Record<string,unknown>={};
  for(const p of meta.parameters){
   const val=p.in==='path'?pathValues[p.name]:p.in==='body'?(request.body??{}):p.in==='header'?Object.entries(request.headers).find(([k])=>k.toLowerCase()===p.name.toLowerCase())?.[1]:request.query[p.name];
   if(p.required)args.push(val);else {const camel=p.name.replace(/[-_]([a-zA-Z])/g,(_,c:string)=>c.toUpperCase());const name=camel[0].toLowerCase()+camel.slice(1);if(val!==undefined)opts[name]=val;}
  }
  if(meta.parameters.some(p=>!p.required))args.push(opts);
  return new Promise((resolve,reject)=>fn.apply(api,[...args,(error:unknown,data:unknown,response?:{status?:number;statusCode?:number})=>{
   const status=response?.status??response?.statusCode;
   if(status)resolve({status,body:data});else if(error)reject(error);else reject(new Error('Official client omitted HTTP status'));
  }]));
 }
}
