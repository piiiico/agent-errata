import importlib.util, json, sys, hashlib
path, fn = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("m", path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
c = json.load(open(""+__import__("sys").argv[3]+"/real_p31_baseline/contract.json"))
body = {k: v for k, v in c.items() if k != "signatures"}
canon = lambda v: json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
msg = b"a2a-contract-v0\n" + canon(body).encode()
print(hashlib.sha256(msg).hexdigest()[:12])
keys = {p["domain"]: p["public_key_ed25519_b64"] for p in c["parties"]}
for s in c["signatures"]:
    f = getattr(m, fn)
    good = f(keys[s["domain"]], s["signature"], msg) if fn != "verify" else f(keys[s["domain"]], s["signature"], msg)
    bad = f(keys[s["domain"]], s["signature"], msg + b"x")
    print(s["domain"], "good->", good, "tampered->", bad)
if hasattr(m, "check_contract_door"): print("door", m.check_contract_door(c))
if hasattr(m, "contract_door"): print("door", m.contract_door(c))
