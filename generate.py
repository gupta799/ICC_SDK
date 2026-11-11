import json,re,hashlib,argparse
from pathlib import Path
r=Path(__file__).parent
parser=argparse.ArgumentParser();parser.add_argument('--spec',type=Path,required=True);args=parser.parse_args()
s=json.loads(args.spec.read_text())
def clean(v):
 if isinstance(v,list):return [clean(x) for x in v]
 if not isinstance(v,dict):return v
 return {k:({name:clean(field) for name,field in x.items()} if k=='properties' else clean(x)) for k,x in v.items() if k in ['type','properties','required','items','enum','minItems','maxItems','minLength','maxLength','minimum','maximum','pattern','allOf','oneOf','anyOf','additionalProperties']}
def ts(v):
 if 'enum' in v:return ' | '.join(json.dumps(x) for x in v['enum'])
 if 'allOf' in v:return '('+' & '.join(ts(x) for x in v['allOf'])+')'
 if v.get('type')=='array':return 'Array<'+ts(v.get('items',{}))+'>'
 if v.get('type')=='object' or 'properties' in v:
  fields=[json.dumps(k)+('' if k in v.get('required',[]) else '?')+': '+ts(x) for k,x in v.get('properties',{}).items()]
  return '{ '+'; '.join(fields)+' }' if fields else 'Record<string, unknown>'
 return {'string':'string','number':'number','integer':'number','boolean':'boolean'}.get(v.get('type'),'unknown')
ops={};types=[]
for path,methods in s['paths'].items():
 if not path.startswith('/icc/'):continue
 for method,o in methods.items():
  if not isinstance(o,dict) or 'operationId' not in o:continue
  n=o['operationId'];params=o.get('parameters',[]);body=next((p['schema'] for p in params if p.get('in')=='body'),None)
  responses={k:clean(x.get('schema',{})) for k,x in o['responses'].items() if k.startswith('2')}
  ops[n]={'method':method.upper(),'path':path,'body':clean(body) if body else None,'parameters':[{k:p[k] for k in ['name','in','required'] if k in p} for p in params],'responses':responses}
  types.append(json.dumps(n)+': { body: '+(ts(body) if body else 'undefined')+'; response: '+' | '.join(ts(x.get('schema',{})) for k,x in o['responses'].items() if k.startswith('2'))+' }')
(r/'src/generated/contracts.json').write_text(json.dumps(ops,indent=2))
(r/'src/generated/operations.ts').write_text('// Generated from the public ICC contract. Run python3 generate.py with the research snapshot available.\nexport interface Operations {\n'+';\n'.join(types)+'\n}\n')
(r/'CONTRACT.md').write_text('Public ICC contract snapshot\n\nSource: https://developer.visaacceptance.com/api-reference-assets/specs/cybs_merged.json\n\nSnapshot SHA256: 52c1405a8294fe702f436dfdf87006f9adf7db5e633a322bc334ff1dd94edbac\n\n37 operations. Schemas contain public field constraints with vendor prose omitted. The credential response wrapper is ambiguous; credential retrieval returns unverified data requiring caller reconciliation. No automatic mutation retries. Direct VIC v2 and TAP verification are outside this initial package.\n')
print('Generated',len(ops),'operations')
