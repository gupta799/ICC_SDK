"""Generate ICC contracts from a caller-supplied, dereferenced Swagger snapshot."""
import json,hashlib,argparse
from pathlib import Path
r=Path(__file__).parent
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--spec',type=Path,required=True);args=parser.parse_args()
raw=args.spec.read_bytes()
s=json.loads(raw)
def clean(v):
 if isinstance(v,list):return [clean(x) for x in v]
 if not isinstance(v,dict):return v
 return {k:({name:clean(field) for name,field in x.items()} if k=='properties' else clean(x)) for k,x in v.items() if k in ['type','properties','required','items','enum','minItems','maxItems','minLength','maxLength','minimum','maximum','pattern','allOf','oneOf','anyOf','additionalProperties']}
def ts(v):
 if 'enum' in v:return ' | '.join(json.dumps(x) for x in v['enum']) or 'never'
 if 'allOf' in v:return '('+' & '.join(ts(x) for x in v['allOf'])+')'
 for union in ['oneOf','anyOf']:
  if union in v:return '('+' | '.join(ts(x) for x in v[union])+')'
 if v.get('type')=='array':return 'Array<'+ts(v.get('items',{}))+'>'
 if v.get('type')=='object' or 'properties' in v:
  fields=[json.dumps(k)+('' if k in v.get('required',[]) else '?')+': '+ts(x) for k,x in v.get('properties',{}).items()]
  if fields:return '{ '+'; '.join(fields)+' }'
  additional=v.get('additionalProperties',{})
  return 'Record<string, '+(ts(additional) if isinstance(additional,dict) else 'unknown')+'>'
 return {'string':'string','number':'number','integer':'number','boolean':'boolean'}.get(v.get('type'),'unknown')
ops={};types=[]
for path,methods in s['paths'].items():
 if not path.startswith('/icc/'):continue
 for method,o in methods.items():
  if not isinstance(o,dict) or 'operationId' not in o:continue
  n=o['operationId'];params=o.get('parameters',[]);body=next((p['schema'] for p in params if p.get('in')=='body'),None)
  if n in ops:raise ValueError(f'Duplicate operationId: {n}')
  responses={k:clean(x.get('schema',{})) for k,x in o['responses'].items() if k.startswith('2')}
  ops[n]={'method':method.upper(),'path':path,'body':clean(body) if body is not None else None,'parameters':[{k:p[k] for k in ['name','in','required'] if k in p} for p in params],'responses':responses}
  response_type=' | '.join(ts(x.get('schema',{})) for k,x in o['responses'].items() if k.startswith('2')) or 'unknown'
  types.append(json.dumps(n)+': { body: '+(ts(body) if body is not None else 'undefined')+'; response: '+response_type+' }')
(r/'src/generated').mkdir(parents=True,exist_ok=True)
(r/'src/generated/contracts.json').write_text(json.dumps(ops,indent=2))
(r/'src/generated/operations.ts').write_text('// Generated from the public ICC contract. Run python3 generate.py with the research snapshot available.\nexport interface Operations {\n'+';\n'.join(types)+'\n}\n')
checksum=hashlib.sha256(raw).hexdigest()
path_count=len({op['path'] for op in ops.values()})
(r/'CONTRACT.md').write_text('Public ICC contract snapshot\n\nSource reference: https://developer.visaacceptance.com/api-reference-assets/specs/cybs_merged.json\n\nInput SHA256: '+checksum+'\n\n'+str(len(ops))+' operations across '+str(path_count)+' paths. The hash identifies the exact file supplied to --spec; generation does not verify its origin. Schemas contain public field constraints with vendor prose omitted. The credential response wrapper is ambiguous; credential retrieval returns unverified data requiring caller reconciliation. No automatic mutation retries. Direct VIC v2 and TAP verification are outside this package.\n')
print('Generated',len(ops),'operations across',path_count,'paths (SHA256 '+checksum+')')
