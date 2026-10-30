```python
#!/usr/bin/env python3
import sys, os, json, re, base64, hashlib, math, struct
from collections import defaultdict

MAXI = (1 << 53) - 1
L = 2**252 + 27742317777372353535851937790883648493
P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P
I = pow(2, (P - 1) // 4, P)
HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX160 = re.compile(r"^[0-9a-f]{160}$")
ACTION = re.compile(r"^[a-z][a-z0-9_.:-]{0,63}$")
LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
SCHEMAS = {
    "a2a-execution-v0": "execution",
    "a2a-revocation-v0": "revocation",
    "a2a-revocation-ack-v0": "revocation_ack",
}

class ParseError(Exception):
    pass

def bad_pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ParseError("duplicate key")
        d[k] = v
    return d

def pi(s):
    if len(s.lstrip("-")) > 4300:
        raise ParseError("integer too long")
    return int(s)

def pc(s):
    if s == "NaN": return float("nan")
    if s == "Infinity": return float("inf")
    if s == "-Infinity": return float("-inf")
    raise ParseError("bad constant")

def depth_ok(v, n=0):
    if n > 512: return False
    if isinstance(v, dict):
        return all(depth_ok(x, n + 1) for x in v.values())
    if isinstance(v, list):
        return all(depth_ok(x, n + 1) for x in v)
    return True

def load(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = json.loads(f.read(), object_pairs_hook=bad_pairs,
                           parse_int=pi, parse_float=float, parse_constant=pc)
        if not depth_ok(v): raise ParseError("too deep")
        return v
    except Exception as e:
        raise ParseError(str(e))

def read_dir(path):
    if not os.path.isdir(path): return []
    return [load(os.path.join(path, x)) for x in sorted(os.listdir(path))
            if os.path.isfile(os.path.join(path, x))]

def isint(x):
    return isinstance(x, int) and not isinstance(x, bool)

def esc(s):
    out = []
    for c in s:
        n = ord(c)
        if c == '"': out.append('\\"')
        elif c == "\\": out.append("\\\\")
        elif c == "\b": out.append("\\b")
        elif c == "\f": out.append("\\f")
        elif c == "\n": out.append("\\n")
        elif c == "\r": out.append("\\r")
        elif c == "\t": out.append("\\t")
        elif n < 32 or 0xD800 <= n <= 0xDFFF:
            out.append("\\u%04x" % n)
        else:
            out.append(c)
    return '"' + ''.join(out) + '"'

def canon(v):
    if v is None: return b"null"
    if v is True: return b"true"
    if v is False: return b"false"
    if isint(v): return str(v).encode()
    if isinstance(v, float):
        if math.isnan(v): return b"NaN"
        if math.isinf(v): return b"Infinity" if v > 0 else b"-Infinity"
        return repr(v).encode()
    if isinstance(v, str): return esc(v).encode("utf-8", "surrogatepass")
    if isinstance(v, list): return b"[" + b",".join(canon(x) for x in v) + b"]"
    if isinstance(v, dict):
        return b"{" + b",".join(canon(k) + b":" + canon(v[k])
                               for k in sorted(v)) + b"}"
    raise ValueError("not json")

def without(d, *ks):
    return {k:v for k,v in d.items() if k not in ks}

def sha(x): return hashlib.sha256(x).digest()
def hx(x): return hashlib.sha256(x).hexdigest()

def b64(s, n=None):
    if not isinstance(s, str): return None
    try:
        x = base64.b64decode(s, validate=True)
        if base64.b64encode(x).decode() != s: return None
        return x if n is None or len(x) == n else None
    except Exception:
        return None

# RFC 8032 Edwards25519 verification.
def decodepoint(s):
    if not isinstance(s, (bytes, bytearray)) or len(s) != 32: return None
    y = int.from_bytes(s, "little") & ((1 << 255) - 1)
    sign = s[31] >> 7
    if y >= P: return None
    yy = y*y % P
    x2 = (yy - 1) * pow(D*yy + 1, P-2, P) % P
    x = pow(x2, (P + 3)//8, P)
    if x*x % P != x2:
        x = x * I % P
    if x*x % P != x2: return None
    if (x & 1) != sign: x = P-x
    return (x, y)

def add(a, b):
    x1,y1 = a; x2,y2 = b
    z = pow(1 + D*x1*x2*y1*y2, P-2, P)
    w = pow(1 - D*x1*x2*y1*y2, P-2, P)
    return ((x1*y2+y1*x2)*z % P, (y1*y2+x1*x2)*w % P)

def mul(a, n):
    r = (0,1)
    while n:
        if n & 1: r = add(r,a)
        a = add(a,a); n >>= 1
    return r

def valid_point(raw):
    q = decodepoint(raw)
    return q is not None and q != (0,1) and mul(q,L) == (0,1)

def verify(pk64, sg64, msg):
    pk = b64(pk64, 32); sg = b64(sg64, 64)
    if pk is None or sg is None or not valid_point(pk): return None
    R = sg[:32]; S = int.from_bytes(sg[32:], "little")
    if decodepoint(R) is None: return False
    A = decodepoint(pk); Rp = decodepoint(R)
    if S >= L: return False
    h = int.from_bytes(sha(R + pk + msg), "little") % L
    return mul((15112221349535400772501151409588531511454012693041857206046113283949847762202,
                46316835694926478169428394003475163141307993866256225615783033603165251855960), S) == add(Rp, mul(A,h))

def strict_sig(s):
    x = b64(s, 64)
    return x is not None and int.from_bytes(x[32:], "little") < L and valid_point(x[:32])

def strict(v, depth=0):
    if depth > 512: return False
    if isinstance(v, str):
        return all(ord(c) not in list(range(32)) + [127] for c in v)
    if v is None or isinstance(v, bool): return True
    if isint(v): return -MAXI <= v <= MAXI
    if isinstance(v, float): return False
    if isinstance(v, list): return all(strict(x, depth+1) for x in v)
    if isinstance(v, dict):
        return all(all(ord(c) < 128 and ord(c) >= 32 for c in k) and strict(x, depth+1)
                   for k,x in v.items())
    return False

def normdomain(x):
    if not isinstance(x,str): return None
    x = x.strip().lower().rstrip(".")
    z = x.split(".")
    if len(z) < 2 or any(not LABEL.fullmatch(a or "") for a in z): return None
    if any(c in x for c in "/@: "): return None
    return x

def bits(x):
    if not isinstance(x,str) or not re.fullmatch(r"[0-9a-f]{8}",x): return None
    n = int(x,16); e=n>>24; m=n&0x7fffff
    if n & 0x00800000 or not m: return None
    return m << (8*(e-3)) if e >= 3 else m >> (8*(3-e))

def party_map(c):
    out={}
    for p in c.get("parties",[]) if isinstance(c,dict) else []:
        if isinstance(p,dict): out[p.get("role")] = p
    return out

def grant_ok(g):
    if not isinstance(g,dict): return False
    allowed={"authorized_actions","prohibited_actions","conditional","delegation","data_access",
             "max_hops","privacy","revocation","finality","witnesses","expiry_height",
             "ordering","approval_policy","limits"}
    if set(g)-allowed: return False
    for q in ("authorized_actions","prohibited_actions"):
        if not isinstance(g.get(q),list) or not all(isinstance(x,str) and x for x in g[q]): return False
    if set(g["authorized_actions"]) & set(g["prohibited_actions"]): return False
    for k in ("data_access",):
        if k in g and g[k] is not None and (not isinstance(g[k],list) or not all(isinstance(x,str) and x for x in g[k])): return False
    for k in ("max_hops","expiry_height"):
        if k in g and g[k] is not None and (not isint(g[k]) or g[k]<0): return False
    if "delegation" in g and g["delegation"] is not None:
        x=g["delegation"]
        if not isinstance(x,dict) or set(x)!={"allowed"} or not isinstance(x["allowed"],list) or not all(isinstance(a,str) and a for a in x["allowed"]): return False
    if "conditional" in g and g["conditional"] is not None:
        x=g["conditional"]
        if not isinstance(x,list): return False
        seen=set()
        for a in x:
            if not isinstance(a,dict) or not isinstance(a.get("action"),str) or not a["action"] or ("requires" in a and not isinstance(a["requires"],str)) or a["action"] in seen: return False
            seen.add(a["action"])
    if "finality" in g and g["finality"] is not None:
        x=g["finality"]
        if not isinstance(x,dict) or set(x)-{"depth","max_target_bits"}: return False
        if "depth" in x and (not isint(x["depth"]) or x["depth"]<1): return False
        if "max_target_bits" in x and bits(x["max_target_bits"]) is None: return False
    if "witnesses" in g and g["witnesses"] is not None:
        if not isinstance(g["witnesses"],list): return False
        for w in g["witnesses"]:
            if not isinstance(w,dict) or not isinstance(w.get("name"),str) or not w["name"] or b64(w.get("public_key_ed25519_b64"),32) is None: return False
    if "privacy" in g and g["privacy"] is not None and (not isinstance(g["privacy"],str) or not g["privacy"]): return False
    if "ordering" in g and g["ordering"] is not None:
        x=g["ordering"]
        if not isinstance(x,dict) or set(x)-{"same_height"} or ("same_height" in x and x["same_height"] is not None and not isinstance(x["same_height"],str)): return False
    if "revocation" in g and g["revocation"] is not None:
        x=g["revocation"]
        if not isinstance(x,dict) or set(x)-{"effective_at","ack_window"} or x.get("effective_at") not in ("anchor","delivery_ack"): return False
        if "ack_window" in x and (not isint(x["ack_window"]) or x["ack_window"]<1): return False
    if "approval_policy" in g and g["approval_policy"] is not None:
        x=g["approval_policy"]
        if not isinstance(x,dict) or set(x)-{"allow_unscoped","approvers"}: return False
        if "allow_unscoped" in x and not isinstance(x["allow_unscoped"],bool): return False
        if "approvers" in x:
            a=x["approvers"]
            if not isinstance(a,list) or not 1<=len(a)<=16: return False
            ns=set(); ks=set(); ca={z.get("action") for z in g.get("conditional",[]) if isinstance(z,dict)}
            for q in a:
                if not isinstance(q,dict) or set(q)-{"name","public_key_ed25519_b64","actions"} or not isinstance(q.get("name"),str) or not q["name"] or b64(q.get("public_key_ed25519_b64"),32) is None or not isinstance(q.get("actions"),list) or not q["actions"] or len(set(q["actions"]))!=len(q["actions"]) or any(not isinstance(y,str) or not y or y not in ca for y in q["actions"]) or q["name"] in ns or q["public_key_ed25519_b64"] in ks: return False
                ns.add(q["name"]); ks.add(q["public_key_ed25519_b64"])
    return True

def door(c):
    if not isinstance(c,dict) or c.get("schema")!="a2a-contract-v0" or not HEX32.fullmatch(c.get("contract_id","")) or not HEX32.fullmatch(c.get("nonce","")): return False
    ps=c.get("parties")
    if not isinstance(ps,list) or len(ps)!=2: return False
    pm=party_map(c)
    if set(pm)!={"principal","contractor"}: return False
    for p in ps:
        if not isinstance(p,dict) or normdomain(p.get("domain")) is None or not isinstance(p.get("key_url"),str) or not p["key_url"].startswith("https://") or b64(p.get("public_key_ed25519_b64"),32) is None: return False
    if normdomain(ps[0]["domain"]) == normdomain(ps[1]["domain"]): return False
    t=c.get("task")
    if not isinstance(t,dict) or not isinstance(t.get("purpose"),str) or not t["purpose"]: return False
    if t.get("payload_digest") is not None and not HEX64.fullmatch(t["payload_digest"]): return False
    if not grant_ok(c.get("grant")) or not strict(c): return False
    if not all(all(32<=ord(z)<=126 for z in k) for k in walk_keys(c)): return False
    e=c.get("establishes"); d=c.get("does_not_establish")
    if not isinstance(e,list) or not e or not isinstance(d,list) or not d: return False
    bad=re.compile(r"\b(performed|deliver(ed|y)|contract|binding|guarantee|escrow|custody|solvent|lawful|fair|certified)\b",re.I)
    if any(isinstance(x,str) and bad.search(x) for x in e): return False
    ds=" ".join(x.lower() for x in d if isinstance(x,str))
    if not (("runtime" in ds or "enforce" in ds) and ("judge" in ds or "liability" in ds or "fault" in ds) and "deviat" in ds and "legal" in ds): return False
    sigs=c.get("signatures")
    if not isinstance(sigs,list): return False
    msg=b"a2a-contract-v0\n"+canon(without(c,"signatures")); good=set()
    for x in sigs:
        if not isinstance(x,dict): return False
        nd=normdomain(x.get("domain")); found=None
        for role,p in pm.items():
            if nd==normdomain(p.get("domain")): found=(role,p)
        if found is None: return False
        if verify(found[1]["public_key_ed25519_b64"],x.get("signature"),msg) is not True: return False
        good.add(found[0])
    return good=={"principal","contractor"}

def walk_keys(v):
    if isinstance(v,dict):
        for k,x in v.items():
            yield k; yield from walk_keys(x)
    elif isinstance(v,list):
        for x in v: yield from walk_keys(x)

def recmsg(r):
    return r["schema"].encode()+b"\n"+canon(without(r,"signatures","anchor"))

def body_strict(r):
    b=without(r,"signatures","anchor")
    if not strict(b): return False
    for k in ("nenrin_ref",):
        if k in b and b[k] is not None and not HEX64.fullmatch(b[k] if isinstance(b[k],str) else ""): return False
    cr=b.get("contract_ref")
    if isinstance(cr,dict):
        for k in ("contract_sha256","payload_digest"):
            if k in cr and not HEX64.fullmatch(cr[k] if isinstance(cr[k],str) else ""): return False
    if r["schema"]=="a2a-execution-v0":
        for k in ("performed_actions","delegated_to"):
            if k in b and (not isinstance(b[k],list) or not all(isinstance(x,str) for x in b[k])): return False
        if "approvals" in b and (not isinstance(b["approvals"],list) or not all(isinstance(x,dict) for x in b["approvals"])): return False
        for a in b.get("approvals",[]):
            for k in ("sig_b64","signature"):
                if k in a and b64(a[k],64) is not None and not strict_sig(a[k]): return False
    return True

def anchor_strict(r):
    a=r.get("anchor")
    if a is None: return True
    if not strict(a): return False
    if not isinstance(a,dict): return True
    if "block_hash" in a and not HEX64.fullmatch(a["block_hash"] if isinstance(a["block_hash"],str) else ""): return False
    for o in a.get("proof",[]) if isinstance(a.get("proof"),list) else []:
        if isinstance(o,dict) and "hex" in o and (not isinstance(o["hex"],str) or not re.fullmatch(r"[0-9a-f]*",o["hex"])): return False
    return True

def signer(r, c, lax=False):
    pm=party_map(c); g=c.get("grant",{})
    sigs=r.get("signatures")
    if not isinstance(sigs,list) or not sigs: return False
    for s in sigs:
        if not isinstance(s,dict): continue
        role=s.get("role"); key=None
        if r["schema"]=="a2a-execution-v0":
            if role=="contractor": key=pm["contractor"]["public_key_ed25519_b64"]
            elif role=="witness":
                for w in g.get("witnesses",[]) if isinstance(g.get("witnesses"),list) else []:
                    if s.get("witness_name")==w.get("name"): key=w.get("public_key_ed25519_b64")
        elif r["schema"]=="a2a-revocation-v0" and role=="principal": key=pm["principal"]["public_key_ed25519_b64"]
        elif r["schema"]=="a2a-revocation-ack-v0" and role=="contractor": key=pm["contractor"]["public_key_ed25519_b64"]
        if key and verify(key,s.get("sig_b64"),recmsg(r)) is True and (lax or (strict(s) and strict_sig(s.get("sig_b64")))): return True
    return False

def header_hash(raw):
    return sha(sha(raw))[::-1].hex()

def main(c, events, view, walks, parent):
    reasons=set(); dev=set(); disp={}; event=[]
    if not isinstance(c,dict):
        return result(None,"underspecified","undetermined","n/a",set(),{"contract_not_verified"},[],{})
    csha=hx(b"a2a-contract-v0\n"+canon(without(c,"signatures")))
    if not isinstance(events,list):
        return result(csha,"underspecified","undetermined",bond(c,"underspecified"),set(),{"input_not_settleable"},[],{})
    own_door=door(c)
    if not own_door: reasons.add("contract_not_verified")
    for s in c.get("signatures",[]) if isinstance(c.get("signatures"),list) else []:
        if isinstance(s,dict) and b64(s.get("signature"),64) is not None and not strict_sig(s["signature"]): reasons.add("contract_signature_not_strict")
    bo=c.get("bond",None)
    if bo is not None and (not isinstance(bo,dict) or not isint(bo.get("amount")) or not 1<=bo["amount"]<=MAXI): reasons.add("bond_malformed")
    if c.get("parent_contract") is not None:
        if parent is None: reasons.add("parent_not_supplied")
        elif not isinstance(parent,dict) or not door(parent) or c.get("parent_contract",{}).get("contract_id") != parent.get("contract_id"):
            reasons.add("parent_narrowing_failed")

    g=c.get("grant",{}) if isinstance(c.get("grant"),dict) else {}
    if own_door:
        if any(not ACTION.fullmatch(x) for x in g.get("authorized_actions",[])+g.get("prohibited_actions",[])): reasons.add("grant_action_name_invalid")
        if any(not ACTION.fullmatch(x.get("action","")) for x in g.get("conditional",[]) if isinstance(x,dict)): reasons.add("grant_action_name_invalid")
        ws=g.get("witnesses",[])
        if len(ws)>32: reasons.add("too_many_witnesses")
        keys=[b64(p.get("public_key_ed25519_b64"),32) for p in party_map(c).values()]
        keys += [b64(w.get("public_key_ed25519_b64"),32) for w in ws]
        if len(set(keys)) != len(keys) or len({w.get("name") for w in ws}) != len(ws): reasons.add("key_conflict")
        if g.get("ordering",{}).get("same_height") not in (None,"conservative"): reasons.add("tie_policy_refused")
        rev=g.get("revocation")
        if isinstance(rev,dict) and rev.get("effective_at")=="delivery_ack" and (not isint(rev.get("ack_window")) or rev["ack_window"]<1): reasons.add("ack_window_missing")
        if not isinstance(g.get("finality"),dict) or not isint(g["finality"].get("depth")) or g["finality"]["depth"]<1: reasons.add("finality_policy_missing")
        if g.get("approval_policy",{}).get("allow_unscoped"): reasons.add("unscoped_approvals_refused")

    headers={}; tip=None; viewok=True
    floor=bits(g.get("finality",{}).get("max_target_bits"))
    lb=c.get("lower_bound")
    hs=view.get("headers") if isinstance(view,dict) else None
    if floor is None or not isinstance(lb,dict) or not isint(lb.get("height")) or not HEX64.fullmatch(lb.get("hash","")) or not isinstance(hs,list) or not hs: viewok=False
    else:
        prev=None
        for h in hs:
            if not isinstance(h,dict) or not isint(h.get("height")) or h["height"]<0 or not isinstance(h.get("hex"),str) or not re.fullmatch(r"[0-9a-f]{160}\n?",h["hex"]): viewok=False; break
            raw=bytes.fromhex(h["hex"].rstrip("\n"))
            hh=header_hash(raw); bt=bits(raw[72:76][::-1].hex())
            if (prev and (h["height"]!=prev[0]+1 or raw[4:36][::-1].hex()!=prev[1])) or bt is None or bt>floor or int(hh,16)>bt: viewok=False; break
            headers[h["height"]]=(hh,raw[36:68]); prev=(h["height"],hh); tip=h["height"]
        if lb["height"] not in headers or headers.get(lb["height"],("",))[0]!=lb["hash"]: viewok=False
    if not viewok: reasons.add("chain_view_rejected")
    if isinstance(view,dict) and isinstance(view.get("headers"),list):
        if not strict(view) or any(not isinstance(h,dict) or not isint(h.get("height")) or not isinstance(h.get("hex"),str) or not HEX160.fullmatch(h["hex"]) for h in view["headers"]): reasons.add("view_not_strict")
    if viewok and len(hs)>200000: reasons.add("input_too_large")

    bound=[]
    seen=set()
    for r in events:
        if not isinstance(r,dict) or r.get("schema") not in SCHEMAS: continue
        try: rh=hx(canon(r))
        except Exception: continue
        if rh in seen: continue
        seen.add(rh)
        ref=r.get("contract_ref") if isinstance(r.get("contract_ref"),dict) else {}
        q=ref.get("contract_sha256")
        if q is None:
            if ref.get("contract_id")==c.get("contract_id"): disp[rh]="unbound"
            continue
        if not isinstance(q,str) or not HEX64.fullmatch(q): disp[rh]="inconsistent"; continue
        if q!=csha: disp[rh]="foreign"; continue
        if ref.get("contract_id")!=c.get("contract_id") or (c.get("task",{}).get("payload_digest") is not None and ref.get("payload_digest")!=c["task"]["payload_digest"]):
            disp[rh]="inconsistent"; continue
        bound.append((r,rh))
    if reasons & {"contract_not_verified","chain_view_rejected","input_too_large"}:
        return finish(c,csha,reasons,dev,event,disp,tip,g)

    kept=[]
    for r,rh in bound:
        ss=signer(r,c); bs=body_strict(r)
        if not ss:
            disp[rh]="record_not_strict" if not bs else ("signature_not_strict" if signer(r,c,True) else "rejected")
        elif not bs:
            disp[rh]="record_not_strict"; reasons.add("record_not_strict")
        elif not anchor_strict(r):
            disp[rh]="anchor_not_strict"; reasons.add("anchor_not_strict")
        elif r["schema"]=="a2a-revocation-v0" and not isinstance(g.get("revocation"),dict):
            disp[rh]="revocation_not_provided_for"
        else: kept.append((r,rh))
    if len(kept)>10000:
        reasons.add("input_too_large")
        return finish(c,csha,reasons,dev,event,disp,tip,g)

    for r,rh in kept:
        allowed={"schema","contract_ref","performed_actions","approvals","delegated_to","nenrin_ref","outcomes","anchor","signatures"} if r["schema"]=="a2a-execution-v0" else ({"schema","contract_ref","revoked_by","anchor","signatures"} if r["schema"]=="a2a-revocation-v0" else {"schema","contract_ref","revocation_sha256","acked_by","anchor","signatures"})
        bad=set(r)-allowed
        if r["schema"]=="a2a-execution-v0":
            pa=r.get("performed_actions")
            if not isinstance(pa,list) or not all(isinstance(x,str) for x in pa) or len(pa)>256 or any(not ACTION.fullmatch(x) for x in pa): bad.add("x")
            for a in r.get("approvals",[]):
                if not isinstance(a,dict) or not ACTION.fullmatch(a.get("action","")): bad.add("x")
        if bad:
            if signer(r,c,True) and r["schema"]=="a2a-execution-v0": dev.add("nonconforming_record")
            else: disp[rh]="rejected"; continue
        if r["schema"]=="a2a-revocation-v0" and r.get("revoked_by")!="principal":
            disp[rh]="ignored"; continue
        a=r.get("anchor",{})
        h=a.get("height") if isinstance(a,dict) and isint(a.get("height")) and a["height"]>=0 else None
        if h is None or not isinstance(a,dict) or not HEX64.fullmatch(a.get("block_hash","")):
            disp[rh]="anchor_incomplete"; reasons.add("anchor_incomplete"); continue
        if h<lb["height"]: disp[rh]="anchor_below_lower_bound"; reasons.add("anchor_below_lower_bound"); continue
        if h not in headers: disp[rh]="anchor_beyond_observed_chain"; reasons.add("anchor_beyond_observed_chain"); continue
        if a["block_hash"]!=headers[h][0]: disp[rh]="orphaned"; continue
        cur=sha(canon(without(r,"anchor"))); ok=isinstance(a.get("proof"),list) and 0<len(a["proof"])<=512
        for o in a.get("proof",[]) if ok else []:
            if not isinstance(o,dict): ok=False; break
            z=o.get("op")
            if z=="sha256": cur=sha(cur)
            elif z=="hexlify": cur=cur.hex().encode()
            elif z in ("append","prepend") and isinstance(o.get("hex"),str) and re.fullmatch(r"[0-9a-f]*",o["hex"]) and len(o["hex"])<=8192:
                cur=(cur+bytes.fromhex(o["hex"])) if z=="append" else (bytes.fromhex(o["hex"])+cur)
            else: ok=False; break
            if len(cur)>65536: ok=False; break
        if not ok or cur!=headers[h][1]:
            disp[rh]="anchor_proof_invalid"; reasons.add("anchor_proof_invalid"); continue
        disp[rh]="accepted"; event.append((h,rh,r))

    event.sort()
    if not reasons:
        revheights=[]
        for h,rh,r in event:
            if r["schema"]=="a2a-revocation-v0":
                revheights.append(h)
        for h,rh,r in event:
            if r["schema"]!="a2a-execution-v0": continue
            pa=r.get("performed_actions",[])
            if any(e<=h for e in revheights):
                if pa: dev.add("revoked")
                continue
            if g.get("expiry_height") is not None and h>g["expiry_height"] and pa: dev.add("after_expiry")
            for a in pa:
                if a in g.get("prohibited_actions",[]): dev.add("prohibited")
                elif any(x.get("action")==a for x in g.get("conditional",[]) if isinstance(x,dict)): dev.add("conditional")
                elif a not in g.get("authorized_actions",[]): dev.add("unauthorized")
            for d in r.get("delegated_to",[]):
                if d not in g.get("delegation",{}).get("allowed",[]): dev.add("delegation")
            for a in r.get("approvals",[]):
                dev.add("forged_approval")
        if c.get("requirements",{}).get("evidence")=="nenrin_required":
            for h,rh,r in event:
                if r["schema"]=="a2a-execution-v0" and not HEX64.fullmatch(r.get("nenrin_ref","") if isinstance(r.get("nenrin_ref"),str) else ""):
                    dev.add("evidence_missing")
    return finish(c,csha,reasons,dev,event,disp,tip,g)

def bond(c, verdict):
    b=c.get("bond")
    if b is None: return "n/a"
    if not isinstance(b,dict) or not isint(b.get("amount")) or not 1<=b["amount"]<=MAXI:
        return "undetermined" if isinstance(b,dict) and b.get("amount") else "n/a"
    return "undetermined" if verdict=="underspecified" else "held"

def finish(c,csha,reasons,dev,event,disp,tip,g):
    if reasons: v="underspecified"; st="undetermined"; dev=set()
    elif dev: v="deviation"; st="final"
    elif not event: v="nothing_to_settle"; st="final"
    else: v="within_grant"; st="final"
    if v!="underspecified" and tip is not None:
        horizon=tip-g.get("finality",{}).get("depth",1)+1
        heights=[h for h,x,r in event]
        if any(h>horizon for h in heights): st="provisional"
    bo=bond(c,v)
    if bo not in ("n/a","undetermined"):
        bo="pending_finality" if st=="provisional" else ("forfeited" if v=="deviation" else "held")
    es=[{"kind":SCHEMAS[r["schema"]],"sha256":rh,"height":h} for h,rh,r in event]
    return result(csha,v,st,bo,dev,reasons,es,disp)

def result(csha,v,st,bo,dev,rea,event,disp):
    return {
        "contract_sha256":csha, "verdict":v, "status":st, "bond_outcome":bo,
        "deviation_codes":sorted(dev) if v=="deviation" else [],
        "underspecified_reasons":sorted(rea) if v=="underspecified" else [],
        "event_set":event, "dispositions":disp
    }

if __name__ == "__main__":
    try:
        if len(sys.argv)!=2: raise ParseError("usage")
        d=sys.argv[1]
        contract=load(os.path.join(d,"contract.json"))
        view=load(os.path.join(d,"view.json"))
        events=read_dir(os.path.join(d,"events"))
        walks=read_dir(os.path.join(d,"nenrin"))
        pp=os.path.join(d,"parent.json")
        parent=load(pp) if os.path.isfile(pp) else None
        print(json.dumps(main(contract,events,view,walks,parent),ensure_ascii=False,separators=(",",":")))
    except Exception as e:
        print(json.dumps({"error":"input parse error"},separators=(",",":")))
        sys.exit(2)
```