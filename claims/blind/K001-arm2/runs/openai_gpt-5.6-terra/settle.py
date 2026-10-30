#!/usr/bin/env python3
import sys, os, json, re, base64, hashlib, math
from urllib.parse import urlparse
from collections import defaultdict
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

MAXI = (1 << 53) - 1
L = (1 << 252) + 27742317777372353535851937790883648493
P = (1 << 255) - 19
D = (-121665 * pow(121666, P - 2, P)) % P
HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX8 = re.compile(r"^[0-9a-f]{8}$")
ACTION = re.compile(r"^[a-z][a-z0-9_.:-]{0,63}$")
HEXANY = re.compile(r"^[0-9a-f]*$")
SCHEMAS = {
    "a2a-execution-v0": "execution",
    "a2a-revocation-v0": "revocation",
    "a2a-revocation-ack-v0": "revocation_ack",
}

def die(reason):
    print(json.dumps({"error": reason}, separators=(",", ":")))
    sys.exit(2)

def no_dups(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ValueError("duplicate key")
        d[k] = v
    return d

def parse_text(s):
    depth = 0
    instr = False
    esc = False
    for ch in s:
        if instr:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                instr = False
        else:
            if ch == '"':
                instr = True
            elif ch in "[{":
                depth += 1
                if depth > 512:
                    raise ValueError("too deep")
            elif ch in "]}":
                depth -= 1
    def pc(x):
        if x == "NaN": return float("nan")
        if x == "Infinity": return float("inf")
        if x == "-Infinity": return float("-inf")
        raise ValueError("bad constant")
    return json.loads(s, object_pairs_hook=no_dups, parse_constant=pc)

def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return parse_text(f.read())

def isint(x):
    return isinstance(x, int) and not isinstance(x, bool)

def strict_num(x):
    return isint(x) and -MAXI <= x <= MAXI

def jescape(s):
    out = []
    for c in s:
        n = ord(c)
        if c == '"': out.append('\\"')
        elif c == '\\': out.append('\\\\')
        elif c == '\b': out.append('\\b')
        elif c == '\f': out.append('\\f')
        elif c == '\n': out.append('\\n')
        elif c == '\r': out.append('\\r')
        elif c == '\t': out.append('\\t')
        elif n < 32: out.append("\\u%04x" % n)
        elif 0xD800 <= n <= 0xDFFF: out.append("\\u%04x" % n)
        else: out.append(c)
    return '"' + ''.join(out) + '"'

def canon(v):
    if v is None: return b"null"
    if v is True: return b"true"
    if v is False: return b"false"
    if isinstance(v, str): return jescape(v).encode("utf-8", "surrogatepass")
    if isint(v): return str(v).encode()
    if isinstance(v, float):
        if math.isnan(v): return b"NaN"
        if math.isinf(v): return b"Infinity" if v > 0 else b"-Infinity"
        return repr(v).encode()
    if isinstance(v, list):
        return b"[" + b",".join(canon(x) for x in v) + b"]"
    if isinstance(v, dict):
        return b"{" + b",".join(
            canon(k) + b":" + canon(v[k]) for k in sorted(v.keys())
        ) + b"}"
    raise ValueError("uncanonicalizable")

def without(d, *ks):
    return {k: v for k, v in d.items() if k not in ks}

def sha(x):
    return hashlib.sha256(x).digest()

def shahex(x):
    return sha(x).hex()

def b64(s, length=None):
    if not isinstance(s, str):
        return None
    try:
        x = base64.b64decode(s.encode("ascii"), validate=True)
    except Exception:
        return None
    if base64.b64encode(x).decode() != s:
        return None
    if length is not None and len(x) != length:
        return None
    return x

def point_ok(pk):
    if not isinstance(pk, bytes) or len(pk) != 32:
        return False
    y = int.from_bytes(pk, "little") & ((1 << 255) - 1)
    sign = pk[31] >> 7
    if y >= P:
        return False
    yy = y * y % P
    x2 = (yy - 1) * pow((D * yy + 1) % P, P - 2, P) % P
    x = pow(x2, (P + 3) // 8, P)
    if x * x % P != x2:
        x = x * pow(2, (P - 1) // 4, P) % P
    if x * x % P != x2:
        return False
    if (x & 1) != sign:
        x = P - x
    if x == 0 and sign:
        return False
    def add(a, b):
        x1, y1 = a; x2_, y2 = b
        q = D * x1 * x2_ * y1 * y2 % P
        return ((x1*y2 + y1*x2_) * pow(1+q, P-2, P) % P,
                (y1*y2 + x1*x2_) * pow(1-q, P-2, P) % P)
    q = (x, y)
    r = (0, 1)
    n = L
    while n:
        if n & 1: r = add(r, q)
        q = add(q, q)
        n >>= 1
    return r == (0, 1) and (x, y) != (0, 1)

def sig_strict(sig):
    return isinstance(sig, bytes) and len(sig) == 64 and \
        int.from_bytes(sig[32:], "little") < L and point_ok(sig[:32])

def verify(pk64, sg64, msg):
    pk = b64(pk64, 32)
    sg = b64(sg64, 64)
    if pk is None or sg is None or not point_ok(pk):
        return None
    try:
        Ed25519PublicKey.from_public_bytes(pk).verify(sg, msg)
        return True
    except InvalidSignature:
        return False
    except Exception:
        return False

def strict(v, depth=0):
    if depth > 512:
        return False
    if isinstance(v, str):
        return not any(ord(c) < 32 or ord(c) == 127 for c in v)
    if v is None or isinstance(v, bool):
        return True
    if isinstance(v, (int, float)):
        return strict_num(v)
    if isinstance(v, list):
        return all(strict(x, depth+1) for x in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) and k.isascii() and
                   not any(ord(c) < 32 or ord(c) == 127 for c in k) and
                   strict(x, depth+1) for k, x in v.items())
    return False

def norm_domain(x):
    if not isinstance(x, str):
        return None
    x = x.strip().lower().rstrip(".")
    if any(c in x for c in "/@: ") or x.count(".") < 1:
        return None
    labels = x.split(".")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", z) for z in labels):
        return None
    return x

def target(bits):
    if not isinstance(bits, int):
        return None
    e = bits >> 24
    m = bits & 0x007fffff
    if bits & 0x00800000 or m == 0:
        return None
    return m << (8*(e-3)) if e >= 3 else m >> (8*(3-e))

def target_hex(s):
    if not isinstance(s, str) or not HEX8.fullmatch(s):
        return None
    return target(int.from_bytes(bytes.fromhex(s), "little"))

def party_map(c):
    out = {}
    for p in c.get("parties", []) if isinstance(c, dict) else []:
        if isinstance(p, dict) and p.get("role") in ("principal", "contractor"):
            out[p["role"]] = p
    return out

def signing_contract(c):
    return b"a2a-contract-v0\n" + canon(without(c, "signatures"))

def signing_record(r):
    return (r.get("schema", "").encode() + b"\n" +
            canon(without(r, "signatures", "anchor")))

def contract_door(c):
    if not isinstance(c, dict):
        return False
    if c.get("schema") != "a2a-contract-v0":
        return False
    if not (isinstance(c.get("contract_id"), str) and HEX32.fullmatch(c["contract_id"]) and
            isinstance(c.get("nonce"), str) and HEX32.fullmatch(c["nonce"])):
        return False
    ps = c.get("parties")
    if not isinstance(ps, list) or len(ps) != 2:
        return False
    pm = party_map(c)
    if set(pm) != {"principal", "contractor"}:
        return False
    ds = []
    for p in ps:
        if not isinstance(p, dict):
            return False
        d = norm_domain(p.get("domain"))
        if d is None or not isinstance(p.get("key_url"), str) or \
           urlparse(p["key_url"]).scheme != "https" or b64(p.get("public_key_ed25519_b64"), 32) is None:
            return False
        ds.append(d)
    if ds[0] == ds[1]:
        return False
    t = c.get("task")
    if not isinstance(t, dict) or not isinstance(t.get("purpose"), str) or not t["purpose"]:
        return False
    if "payload_digest" in t and t["payload_digest"] is not None and \
       (not isinstance(t["payload_digest"], str) or not HEX64.fullmatch(t["payload_digest"])):
        return False
    g = c.get("grant")
    if not isinstance(g, dict):
        return False
    allowed = {"authorized_actions","prohibited_actions","conditional","delegation",
               "data_access","max_hops","privacy","revocation","finality","witnesses",
               "expiry_height","ordering","approval_policy","limits"}
    if any(k not in allowed for k in g):
        return False
    for k in ("authorized_actions", "prohibited_actions"):
        if not isinstance(g.get(k), list) or any(not isinstance(x, str) or not x for x in g[k]):
            return False
    if set(g["authorized_actions"]) & set(g["prohibited_actions"]):
        return False
    if g.get("data_access") is not None and (not isinstance(g["data_access"], list) or
       any(not isinstance(x, str) or not x for x in g["data_access"])): return False
    for k in ("max_hops", "expiry_height"):
        if g.get(k) is not None and (not isint(g[k]) or g[k] < 0): return False
    if g.get("delegation") is not None:
        z = g["delegation"]
        if not isinstance(z, dict) or set(z) != {"allowed"} or not isinstance(z["allowed"], list) or \
           any(not isinstance(x, str) or not x for x in z["allowed"]): return False
    if g.get("conditional") is not None:
        z = g["conditional"]
        if not isinstance(z, list): return False
        seen = set()
        for x in z:
            if not isinstance(x, dict) or not isinstance(x.get("action"), str) or not x["action"] or \
               ("requires" in x and not isinstance(x["requires"], str)) or x["action"] in seen: return False
            seen.add(x["action"])
    if g.get("finality") is not None:
        z = g["finality"]
        if not isinstance(z, dict) or any(k not in {"depth","max_target_bits"} for k in z): return False
        if "depth" in z and (not isint(z["depth"]) or z["depth"] < 1): return False
        if "max_target_bits" in z and target_hex(z["max_target_bits"]) is None: return False
    if g.get("witnesses") is not None:
        if not isinstance(g["witnesses"], list): return False
        for x in g["witnesses"]:
            if not isinstance(x, dict) or not isinstance(x.get("name"), str) or not x["name"] or \
               b64(x.get("public_key_ed25519_b64"), 32) is None: return False
    if g.get("privacy") is not None and (not isinstance(g["privacy"], str) or not g["privacy"]): return False
    if g.get("ordering") is not None:
        z = g["ordering"]
        if not isinstance(z, dict) or any(k != "same_height" for k in z) or \
           ("same_height" in z and z["same_height"] is not None and not isinstance(z["same_height"], str)): return False
    if g.get("approval_policy") is not None:
        z = g["approval_policy"]
        if not isinstance(z, dict) or any(k not in {"allow_unscoped","approvers"} for k in z): return False
        if "allow_unscoped" in z and not isinstance(z["allow_unscoped"], bool): return False
        if "approvers" in z:
            a = z["approvers"]
            if not isinstance(a, list) or not (1 <= len(a) <= 16): return False
            ns, ks = set(), set()
            ca = {x.get("action") for x in g.get("conditional", []) if isinstance(x, dict)}
            for q in a:
                if not isinstance(q, dict) or any(k not in {"name","public_key_ed25519_b64","actions"} for k in q) or \
                   not isinstance(q.get("name"), str) or not q["name"] or \
                   b64(q.get("public_key_ed25519_b64"),32) is None or not isinstance(q.get("actions"),list) or \
                   not q["actions"] or len(set(q["actions"])) != len(q["actions"]) or \
                   any(not isinstance(x,str) or not x or x not in ca for x in q["actions"]): return False
                if q["name"] in ns or q["public_key_ed25519_b64"] in ks: return False
                ns.add(q["name"]); ks.add(q["public_key_ed25519_b64"])
    if g.get("revocation") is not None:
        z = g["revocation"]
        if not isinstance(z, dict) or any(k not in {"effective_at","ack_window"} for k in z) or \
           z.get("effective_at") not in ("anchor","delivery_ack") or \
           ("ack_window" in z and (not isint(z["ack_window"]) or z["ack_window"] < 1)): return False
    if not strict(c) or any(any(not (32 <= ord(ch) <= 126) for ch in k) for k in walk_keys(c)):
        return False
    est = c.get("establishes")
    if not isinstance(est, list) or not est: return False
    bad = re.compile(r"\bperformed\b|\bdeliver(ed|y)\b|\bmoney (moved|was sent)\b|"
                     r"\bfunds? (moved|were sent|were transferred)\b|\bpaid\b(?!\s+for\s+(this|the)\s+record)|"
                     r"\bpayment (was|has been) (made|completed|settled|received)\b|\bcontract\b|\bbinding\b|"
                     r"\bguarantee|\bescrow\b|\bcustody\b|\bsolvent\b|\blawful\b|\bfair\b|\bcertified\b", re.I)
    if any(isinstance(x,str) and bad.search(x) for x in est): return False
    dne = c.get("does_not_establish")
    if not isinstance(dne,list) or not dne: return False
    joined = " ".join(x.lower() for x in dne if isinstance(x,str))
    if not (("runtime" in joined or "enforce" in joined) and
            ("judge" in joined or "liability" in joined or "fault" in joined) and
            "deviat" in joined and "legal" in joined): return False
    sigs = c.get("signatures")
    if not isinstance(sigs,list): return False
    msg = signing_contract(c)
    good = set()
    domains = {norm_domain(x["domain"]): x for x in ps}
    for z in sigs:
        if not isinstance(z, dict):
            continue
        p = domains.get(norm_domain(z.get("domain")))
        if p is None: return False
        v = verify(p["public_key_ed25519_b64"], z.get("signature"), msg)
        if v is not True: return False
        good.add(p["role"])
    return good == {"principal","contractor"}

def walk_keys(v):
    if isinstance(v, dict):
        for k, x in v.items():
            yield k
            yield from walk_keys(x)
    elif isinstance(v, list):
        for x in v: yield from walk_keys(x)

def record_body_strict(r):
    b = without(r, "signatures", "anchor")
    if not strict(b): return False
    if "nenrin_ref" in r and r["nenrin_ref"] is not None and (not isinstance(r["nenrin_ref"],str) or not HEX64.fullmatch(r["nenrin_ref"])): return False
    cr = r.get("contract_ref")
    if isinstance(cr,dict):
        for k in ("contract_sha256","payload_digest"):
            if k in cr and (not isinstance(cr[k],str) or not HEX64.fullmatch(cr[k])): return False
    if r.get("schema") == "a2a-execution-v0":
        for k in ("performed_actions","delegated_to"):
            if k in r and (not isinstance(r[k],list) or any(not isinstance(x,str) for x in r[k])): return False
        if "approvals" in r:
            if not isinstance(r["approvals"],list): return False
            for a in r["approvals"]:
                if isinstance(a,dict):
                    for k in ("sig_b64","signature"):
                        if k in a:
                            q = b64(a[k],64)
                            if q is not None and not sig_strict(q): return False
    return True

def anchor_strict(r):
    if "anchor" not in r: return True
    a = r["anchor"]
    if not strict(a): return False
    if not isinstance(a,dict): return True
    if "block_hash" in a and (not isinstance(a["block_hash"],str) or not HEX64.fullmatch(a["block_hash"])): return False
    if isinstance(a.get("proof"),list):
        for z in a["proof"]:
            if isinstance(z,dict) and "hex" in z and (not isinstance(z["hex"],str) or not HEXANY.fullmatch(z["hex"]) or len(z["hex"]) % 2): return False
    return True

def main():
    if len(sys.argv) != 2:
        die("usage")
    root = sys.argv[1]
    try:
        contract = read_json(os.path.join(root,"contract.json"))
        view = read_json(os.path.join(root,"view.json"))
        events = []
        ep = os.path.join(root,"events")
        if os.path.isdir(ep):
            for n in sorted(os.listdir(ep)):
                events.append(read_json(os.path.join(ep,n)))
        walks = []
        np = os.path.join(root,"nenrin")
        if os.path.isdir(np):
            for n in sorted(os.listdir(np)):
                walks.append(read_json(os.path.join(np,n)))
        parent = read_json(os.path.join(root,"parent.json")) if os.path.exists(os.path.join(root,"parent.json")) else None
    except Exception:
        die("invalid json")

    reasons, deviations, disp = set(), set(), {}
    if not isinstance(contract,dict):
        out = {"contract_sha256":None,"verdict":"underspecified","status":"undetermined",
               "bond_outcome":"n/a","deviation_codes":[],"underspecified_reasons":["contract_not_verified"],
               "event_set":[],"dispositions":{}}
        print(json.dumps(out,separators=(",",":"),ensure_ascii=False)); return

    csha = shahex(signing_contract(contract))
    if not isinstance(events,list):
        reasons.add("input_not_settleable")
    door = contract_door(contract)
    if not door: reasons.add("contract_not_verified")
    g = contract.get("grant") if isinstance(contract.get("grant"),dict) else {}
    pm = party_map(contract)

    for z in contract.get("signatures",[]) if isinstance(contract.get("signatures"),list) else []:
        if isinstance(z,dict):
            q = b64(z.get("signature"),64)
            if q is not None and not sig_strict(q): reasons.add("contract_signature_not_strict")
    bond = contract.get("bond")
    bondgood = isinstance(bond,dict) and isint(bond.get("amount")) and 1 <= bond["amount"] <= MAXI
    if bond is not None and not bondgood: reasons.add("bond_malformed")
    if contract.get("parent_contract") is not None:
        if parent is None: reasons.add("parent_not_supplied")
        elif not isinstance(parent,dict) or not contract_door(parent) or \
             not isinstance(contract.get("parent_contract"),dict) or \
             contract["parent_contract"].get("contract_id") != parent.get("contract_id"):
            reasons.add("parent_narrowing_failed")

    # settleable terms
    for x in g.get("authorized_actions",[]) if isinstance(g.get("authorized_actions"),list) else []:
        if not ACTION.fullmatch(x): reasons.add("grant_action_name_invalid")
    for x in g.get("prohibited_actions",[]) if isinstance(g.get("prohibited_actions"),list) else []:
        if not ACTION.fullmatch(x): reasons.add("grant_action_name_invalid")
    for x in g.get("conditional",[]) if isinstance(g.get("conditional"),list) else []:
        if isinstance(x,dict) and not ACTION.fullmatch(x.get("action","")): reasons.add("grant_action_name_invalid")
    ws = g.get("witnesses",[]) if isinstance(g.get("witnesses"),list) else []
    if len(ws) > 32: reasons.add("too_many_witnesses")
    keys = []
    for p in pm.values():
        keys.append(b64(p.get("public_key_ed25519_b64"),32))
    names = set()
    for w in ws:
        if isinstance(w,dict):
            names.add(w.get("name"))
            keys.append(b64(w.get("public_key_ed25519_b64"),32))
    if len(names) != len(ws) or len([x for x in keys if x is not None]) != len(set(x for x in keys if x is not None)):
        reasons.add("key_conflict")
    ordering = g.get("ordering")
    if isinstance(ordering,dict) and "same_height" in ordering and ordering["same_height"] not in (None,"conservative"):
        reasons.add("tie_policy_refused")
    revpol = g.get("revocation")
    if isinstance(revpol,dict) and revpol.get("effective_at") == "delivery_ack" and \
       (not isint(revpol.get("ack_window")) or revpol["ack_window"] < 1):
        reasons.add("ack_window_missing")
    fin = g.get("finality")
    if not isinstance(fin,dict) or not isint(fin.get("depth")) or fin["depth"] < 1:
        reasons.add("finality_policy_missing")
    if isinstance(g.get("approval_policy"),dict) and g["approval_policy"].get("allow_unscoped"):
        reasons.add("unscoped_approvals_refused")

    # View
    headers, hmap, tip = [], {}, None
    viewok = True
    floor = target_hex(fin.get("max_target_bits")) if isinstance(fin,dict) else None
    lb = contract.get("lower_bound")
    if floor is None or not isinstance(lb,dict) or not isint(lb.get("height")) or \
       not isinstance(lb.get("hash"),str) or not HEX64.fullmatch(lb["hash"]) or \
       not isinstance(view,dict) or not isinstance(view.get("headers"),list) or not view["headers"]:
        viewok = False
    else:
        prev = None
        for x in view["headers"]:
            if not isinstance(x,dict) or not isint(x.get("height")) or x["height"] < 0 or \
               not isinstance(x.get("hex"),str) or not re.fullmatch(r"[0-9a-f]{160}\n?",x["hex"]):
                viewok=False; break
            raw = bytes.fromhex(x["hex"].rstrip("\n"))
            hh = sha(sha(raw))[::-1].hex()
            if prev is not None and (x["height"] != prev[0]+1 or raw[4:36][::-1].hex() != prev[1]):
                viewok=False; break
            bt = target(int.from_bytes(raw[72:76],"little"))
            if bt is None or bt > floor or int(hh,16) > bt:
                viewok=False; break
            prev=(x["height"],hh); hmap[x["height"]] = (hh,raw); headers.append(x)
        if lb.get("height") not in hmap or hmap[lb["height"]][0] != lb["hash"]:
            viewok=False
    if not viewok: reasons.add("chain_view_rejected")
    else: tip=headers[-1]["height"]
    if isinstance(view,dict) and isinstance(view.get("headers"),list):
        vst = strict(view)
        for x in view["headers"]:
            if not isinstance(x,dict) or not isint(x.get("height")) or not isinstance(x.get("hex"),str) or \
               not re.fullmatch(r"[0-9a-f]{160}",x["hex"]): vst=False
        if not vst: reasons.add("view_not_strict")
    if viewok and len(headers)>200000: reasons.add("input_too_large")

    # Binding and triage
    candidates=[]
    seen=set()
    if isinstance(events,list):
        for r in events:
            if not isinstance(r,dict) or r.get("schema") not in SCHEMAS: continue
            try: rh=shahex(canon(r))
            except Exception: continue
            if rh in seen: continue
            seen.add(rh)
            ref=r.get("contract_ref") if isinstance(r.get("contract_ref"),dict) else {}
            if ref.get("contract_sha256") is None:
                if ref.get("contract_id")==contract.get("contract_id"): disp[rh]="unbound"
                continue
            if not isinstance(ref.get("contract_sha256"),str) or not HEX64.fullmatch(ref["contract_sha256"]):
                disp[rh]="inconsistent"; continue
            if ref["contract_sha256"] != csha:
                disp[rh]="foreign"; continue
            if ref.get("contract_id") != contract.get("contract_id") or \
               (contract.get("task",{}).get("payload_digest") is not None and
                ref.get("payload_digest") != contract["task"]["payload_digest"]):
                disp[rh]="inconsistent"; continue
            candidates.append((rh,r))

    if not (not door or not viewok or "input_too_large" in reasons):
        kept=[]
        for rh,r in candidates:
            bodyok=record_body_strict(r)
            msg=signing_record(r)
            strictsigned=False; lax=False
            sigs=r.get("signatures")
            if isinstance(sigs,list):
                for z in sigs:
                    if not isinstance(z,dict): continue
                    role=z.get("role"); pk=None
                    if role=="contractor" and r["schema"] in ("a2a-execution-v0","a2a-revocation-ack-v0"):
                        pk=pm.get("contractor",{}).get("public_key_ed25519_b64")
                    elif role=="principal" and r["schema"]=="a2a-revocation-v0":
                        pk=pm.get("principal",{}).get("public_key_ed25519_b64")
                    elif role=="witness" and r["schema"]=="a2a-execution-v0":
                        for w in ws:
                            if w.get("name")==z.get("witness_name"): pk=w.get("public_key_ed25519_b64")
                    if pk:
                        v=verify(pk,z.get("sig_b64"),msg)
                        if v: lax=True
                        q=b64(z.get("sig_b64"),64)
                        if v and q is not None and sig_strict(q) and strict(z): strictsigned=True
            if not strictsigned:
                disp[rh]="record_not_strict" if not bodyok else ("signature_not_strict" if lax else "rejected")
                continue
            if not bodyok:
                disp[rh]="record_not_strict"; reasons.add("record_not_strict"); continue
            if not anchor_strict(r):
                disp[rh]="anchor_not_strict"; reasons.add("anchor_not_strict"); continue
            if r["schema"]=="a2a-revocation-v0" and not isinstance(g.get("revocation"),dict):
                disp[rh]="revocation_not_provided_for"; continue
            if r["schema"]=="a2a-revocation-v0" and r.get("revoked_by")!="principal":
                disp[rh]="ignored"; continue
            kept.append((rh,r))
        if len(kept)>10000:
            reasons.add("input_too_large"); kept=[]
        accepted=[]; orphaned=[]
        for rh,r in kept:
            a=r.get("anchor")
            if not isinstance(a,dict) or not isint(a.get("height")) or a["height"]<0 or \
               not isinstance(a.get("block_hash"),str) or not HEX64.fullmatch(a["block_hash"]):
                disp[rh]="anchor_incomplete"; reasons.add("anchor_incomplete"); continue
            h=a["height"]
            if h < lb["height"]:
                disp[rh]="anchor_below_lower_bound"; reasons.add("anchor_below_lower_bound"); continue
            if h not in hmap:
                disp[rh]="anchor_beyond_observed_chain"; reasons.add("anchor_beyond_observed_chain"); continue
            if a["block_hash"] != hmap[h][0]:
                disp[rh]="orphaned"; orphaned.append(h); continue
            cur=sha(canon(without(r,"anchor")))
            proof=a.get("proof")
            good=isinstance(proof,list) and 1<=len(proof)<=512
            if good:
                try:
                    for z in proof:
                        if not isinstance(z,dict): raise ValueError()
                        op=z.get("op")
                        if op=="sha256": cur=sha(cur)
                        elif op=="hexlify": cur=cur.hex().encode()
                        elif op in ("append","prepend") and isinstance(z.get("hex"),str) and HEXANY.fullmatch(z["hex"]) and len(z["hex"])%2==0:
                            q=bytes.fromhex(z["hex"])
                            if len(q)>4096: raise ValueError()
                            cur=cur+q if op=="append" else q+cur
                        else: raise ValueError()
                        if len(cur)>65536: raise ValueError()
                    good = cur == hmap[h][1][36:68]
                except Exception: good=False
            if not good:
                disp[rh]="anchor_proof_invalid"; reasons.add("anchor_proof_invalid"); continue
            disp[rh]="accepted"; accepted.append((h,rh,r))
        accepted.sort()
        # basic grant walk
        revs=[]
        for h,rh,r in accepted:
            if r["schema"]=="a2a-revocation-v0":
                revs.append((h,rh))
        for h,rh,r in accepted:
            if r["schema"]!="a2a-execution-v0": continue
            if any(e<=h for e,_ in revs):
                for x in r.get("performed_actions",[]):
                    if isinstance(x,str): deviations.add("revoked")
                continue
            for x in r.get("performed_actions",[]):
                if not isinstance(x,str): continue
                if g.get("expiry_height") is not None and h>g["expiry_height"]: deviations.add("after_expiry")
                if x in g.get("prohibited_actions",[]): deviations.add("prohibited")
                elif any(isinstance(q,dict) and q.get("action")==x for q in g.get("conditional",[])):
                    deviations.add("conditional")
                elif x not in g.get("authorized_actions",[]): deviations.add("unauthorized")
            allowed=g.get("delegation",{}).get("allowed",[]) if isinstance(g.get("delegation"),dict) else []
            for x in r.get("delegated_to",[]):
                if x not in allowed: deviations.add("delegation")
        event_set=[{"kind":SCHEMAS[r["schema"]],"sha256":rh,"height":h} for h,rh,r in accepted]
    else:
        accepted=[]; orphaned=[]; event_set=[]

    if reasons:
        verdict="underspecified"; status="undetermined"; deviations=set()
    elif deviations:
        verdict="deviation"
        horizon=tip-fin["depth"]+1
        status="final" if all(h<=horizon for h,_,_ in accepted) and all(h<=horizon for h in orphaned) else "provisional"
    else:
        verdict="nothing_to_settle" if not event_set else "within_grant"
        horizon=tip-fin["depth"]+1
        status="final" if all(h<=horizon for h,_,_ in accepted) and all(h<=horizon for h in orphaned) else "provisional"

    if bond is None: bo="n/a"
    elif not bondgood: bo="undetermined" if isinstance(bond,dict) and bond.get("amount") else "n/a"
    elif verdict=="underspecified": bo="undetermined"
    elif status=="provisional": bo="pending_finality"
    elif verdict=="deviation": bo="forfeited"
    else: bo="held"

    out={"contract_sha256":csha,"verdict":verdict,"status":status,"bond_outcome":bo,
         "deviation_codes":sorted(deviations),"underspecified_reasons":sorted(reasons),
         "event_set":event_set,"dispositions":disp}
    print(json.dumps(out,separators=(",",":"),ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except (ValueError, OverflowError, RecursionError):
        die("invalid input")
