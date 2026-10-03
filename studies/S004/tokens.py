# tokens.py <capdir>...  o200k_base token count of the main request's tools / system / whole body (a common yardstick, not each vendor's tokenizer)
import json,sys,os,tiktoken
e=tiktoken.get_encoding('o200k_base'); P="Without using any tools, list every token starting with S003C-"; n=0
for d in sys.argv[1:]:
    best=None
    for f in os.listdir(d):
        if not(f.startswith('req-') and f.endswith('.json')): continue
        try: b=json.load(open(f'{d}/{f}'))
        except Exception: continue
        b=b.get('body',b) if isinstance(b,dict) else b
        s=json.dumps(b)
        if P not in s: continue
        if not best or len(s)>len(best[1]): best=(b,s)
    if not best: print(d,'NO_MAIN'); continue
    n+=1; b,s=best; T=lambda x:0 if x is None else len(e.encode(json.dumps(x)))
    msgs=b.get('messages') or b.get('input') or b.get('contents') or []
    sysm=[m for m in msgs if isinstance(m,dict) and m.get('role') in('system','developer')]
    print(f"{d}\ttotal={len(e.encode(s))}\ttools={T(b.get('tools'))}\tsystem={T(b.get('system'))+T(b.get('instructions'))+T(b.get('systemInstruction'))+sum(T(m) for m in sysm)}")
if n==0: sys.exit("FLOOR: 0 parsed")
