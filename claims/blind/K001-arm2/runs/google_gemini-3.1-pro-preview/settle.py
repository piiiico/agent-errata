import sys
import json
import base64
import re
import hashlib
import math
import os
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

sys.set_int_max_str_digits(4300)
L = 2**252 + 27742317777372353535851937790883648493

class StrictJSONDecoder(json.JSONDecoder):
    def __init__(self, **kwargs):
        super().__init__(object_pairs_hook=self.strict_object_pairs, parse_constant=self.strict_constant, **kwargs)
        
    def strict_object_pairs(self, pairs):
        d = {}
        for k, v in pairs:
            if k in d:
                raise ValueError("Duplicate key")
            d[k] = v
        return d
        
    def strict_constant(self, s):
        if s in ('NaN', 'Infinity', '-Infinity'):
            return float(s)
        raise ValueError(f"Invalid constant {s}")

def load_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    depth = 0
    in_string = False
    escape = False
    for char in content:
        if escape:
            escape = False
            continue
        if char == '"':
            in_string = not in_string
        elif char == '\\' and in_string:
            escape = True
        elif not in_string:
            if char in '[{':
                depth += 1
                if depth > 512:
                    raise ValueError("Nested deeper than 512")
            elif char in ']}':
                depth -= 1
                
    # Detect exact invalid constants not caught by parse_constant
    # json.loads native might accept `nan`, `+Infinity`, `infinity` under some conditions without parse_constant triggers if not careful, 
    # but python native throws ValueError for these by default anyway except `NaN`, `Infinity`, `-Infinity`.
    return json.loads(content, cls=StrictJSONDecoder)

def canonical(v):
    if v is None: return b"null"
    if isinstance(v, bool): return b"true" if v else b"false"
    if isinstance(v, int): return str(v).encode('utf-8')
    if isinstance(v, float):
        if math.isnan(v): return b"NaN"
        if math.isinf(v): return b"Infinity" if v > 0 else b"-Infinity"
        return repr(v).encode('utf-8')
    if isinstance(v, str):
        out = ['"']
        for c in v:
            o = ord(c)
            if c == '"': out.append('\\"')
            elif c == '\\': out.append('\\\\')
            elif o == 0x08: out.append('\\b')
            elif o == 0x0c: out.append('\\f')
            elif o == 0x0a: out.append('\\n')
            elif o == 0x0d: out.append('\\r')
            elif o == 0x09: out.append('\\t')
            elif 0x00 <= o <= 0x1f: out.append(f'\\u{o:04x}')
            elif 0xd800 <= o <= 0xdfff: out.append(f'\\u{o:04x}')
            else: out.append(c)
        out.append('"')
        return "".join(out).encode('utf-8')
    if isinstance(v, list):
        return b"[" + b",".join(canonical(x) for x in v) + b"]"
    if isinstance(v, dict):
        keys = sorted(v.keys())
        return b"{" + b",".join(canonical(k) + b":" + canonical(v[k]) for k in keys) + b"}"
    raise ValueError("Unsupported type")

def is_canonical_b64(s):
    if not isinstance(s, str): return False
    try:
        dec = base64.b64decode(s, validate=True)
        return base64.b64encode(dec).decode('ascii') == s
    except:
        return False

def check_pubkey(dec):
    if len(dec) != 32: return False
    try:
        pk = Ed25519PublicKey.from_public_bytes(dec)
        return pk
    except:
        return False

def verify_sig(pub_b64, sig_b64, msg):
    if not is_canonical_b64(pub_b64) or not is_canonical_b64(sig_b64): return "unusable"
    pub = base64.b64decode(pub_b64)
    sig = base64.b64decode(sig_b64)
    if len(pub) != 32 or len(sig) != 64: return "unusable"
    pk = check_pubkey(pub)
    if not pk: return "unusable"
    try:
        pk.verify(sig, msg)
        return True
    except:
        return False

def is_strict_sig_only(sig_bytes):
    if len(sig_bytes) != 64: return False
    s = int.from_bytes(sig_bytes[32:], 'little')
    if s >= L: return False
    r_bytes = sig_bytes[:32]
    return check_pubkey(r_bytes) is not False

def is_strict_sig(pub_b64, sig_b64, msg):
    if not is_canonical_b64(sig_b64): return False
    sig = base64.b64decode(sig_b64)
    if len(sig) != 64: return False
    if not is_strict_sig_only(sig): return False
    return verify_sig(pub_b64, sig_b64, msg) == True

def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)

def is_safe_int(v):
    return is_int(v) and -9007199254740991 <= v <= 9007199254740991

def is_strict(v, depth=0):
    if depth > 512: return False
    if isinstance(v, str):
        return not any(0 <= ord(c) <= 0x1f or ord(c) == 0x7f for c in v)
    if is_int(v):
        return is_safe_int(v)
    if isinstance(v, float):
        return False
    if isinstance(v, list):
        return all(is_strict(x, depth+1) for x in v)
    if isinstance(v, dict):
        for k in v:
            if not all(0 <= ord(c) <= 0x7f for c in k): return False
            if any(0 <= ord(c) <= 0x1f or ord(c) == 0x7f for c in k): return False
            if not is_strict(v[k], depth+1): return False
        return True
    return True

def is_body_strict(rec):
    body = {k:v for k,v in rec.items() if k not in ("signatures", "anchor")}
    if not is_strict(body): return False
    if "nenrin_ref" in rec:
        nr = rec["nenrin_ref"]
        if nr is not None and not (isinstance(nr, str) and re.match(r'^[0-9a-f]{64}$', nr)): return False
    cref = rec.get("contract_ref", {})
    if isinstance(cref, dict):
        if "contract_sha256" in cref:
            csha = cref["contract_sha256"]
            if not (isinstance(csha, str) and re.match(r'^[0-9a-f]{64}$', csha)): return False
        if "payload_digest" in cref:
            pd = cref["payload_digest"]
            if not (isinstance(pd, str) and re.match(r'^[0-9a-f]{64}$', pd)): return False
    if rec.get("schema") == "a2a-execution-v0":
        if "performed_actions" in rec:
            pa = rec["performed_actions"]
            if not isinstance(pa, list) or not all(isinstance(x, str) for x in pa): return False
        if "delegated_to" in rec:
            dt = rec["delegated_to"]
            if not isinstance(dt, list) or not all(isinstance(x, str) for x in dt): return False
        if "approvals" in rec:
            app = rec["approvals"]
            if not isinstance(app, list) or not all(isinstance(x, dict) for x in app): return False
            for a in app:
                for k in ("sig_b64", "signature"):
                    if k in a:
                        s = a[k]
                        if isinstance(s, str):
                            try:
                                s_dec = base64.b64decode(s)
                                if len(s_dec) == 64 and not is_strict_sig_only(s_dec): return False
                            except: pass
    return True

def is_anchor_strict(anchor):
    if not is_strict(anchor): return False
    if "block_hash" in anchor:
        bh = anchor["block_hash"]
        if not (isinstance(bh, str) and re.match(r'^[0-9a-f]{64}$', bh)): return False
    if "proof" in anchor and isinstance(anchor["proof"], list):
        for op in anchor["proof"]:
            if isinstance(op, dict) and "hex" in op:
                hx = op["hex"]
                if not (isinstance(hx, str) and re.match(r'^([0-9a-f]{2})*$', hx)): return False
    return True

def get_record_signing_bytes(rec):
    c = {k:v for k,v in rec.items() if k not in ("signatures", "anchor")}
    ctx = b"a2a-execution-v0\n" if rec.get("schema") == "a2a-execution-v0" else b"a2a-revocation-v0\n" if rec.get("schema") == "a2a-revocation-v0" else b"a2a-revocation-ack-v0\n"
    return ctx + canonical(c)

def check_record_signed(rec, contract_keys):
    schema = rec.get("schema")
    sigs = rec.get("signatures")
    if not isinstance(sigs, list) or not sigs: return False, False
    rs_bytes = get_record_signing_bytes(rec)
    strict, lax = False, False
    for s in sigs:
        if not isinstance(s, dict): continue
        if not is_strict(s): continue
        role = s.get("role")
        sig_b64 = s.get("sig_b64")
        key_to_use = None
        if schema == "a2a-execution-v0":
            if role == "contractor": key_to_use = contract_keys.get("contractor")
            elif role == "witness" and "witness_name" in s: key_to_use = contract_keys.get("witnesses", {}).get(s["witness_name"])
        elif schema == "a2a-revocation-v0":
            if role == "principal": key_to_use = contract_keys.get("principal")
        elif schema == "a2a-revocation-ack-v0":
            if role == "contractor": key_to_use = contract_keys.get("contractor")
        if not key_to_use: continue
        if is_strict_sig(key_to_use, sig_b64, rs_bytes): strict = True
        elif verify_sig(key_to_use, sig_b64, rs_bytes) == True: lax = True
    return strict, lax

def normalize_domain(d):
    d = d.strip().lower()
    while d.endswith('.'): d = d[:-1]
    if any(c in d for c in '/@: ') or any(c.isspace() for c in d): return None
    labels = d.split('.')
    if len(labels) < 2: return None
    for l in labels:
        if not re.match(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$', l): return None
    return d

def check_numbers(v):
    if is_int(v):
        if not (-9007199254740991 <= v <= 9007199254740991): return False
    elif isinstance(v, float): return False
    elif isinstance(v, list):
        for x in v:
            if not check_numbers(x): return False
    elif isinstance(v, dict):
        for k in v:
            if not check_numbers(v[k]): return False
    return True

def check_printable_keys(v):
    if isinstance(v, dict):
        for k in v:
            if not all(0x20 <= ord(c) <= 0x7E for c in k): return False
            if not check_printable_keys(v[k]): return False
        return True
    elif isinstance(v, list):
        return all(check_printable_keys(x) for x in v)
    return True

def decode_compact(hex_str):
    bits = int(hex_str, 16)
    exp = bits >> 24
    mant = bits & 0x007fffff
    if (bits & 0x00800000) or mant == 0: return None
    if exp >= 3: return mant << (8 * (exp - 3))
    else: return mant >> (8 * (3 - exp))

def check_door(contract):
    codes = set()
    if not isinstance(contract, dict): return False, {"contract_not_verified"}
    if contract.get("schema") != "a2a-contract-v0": codes.add("schema")
    cid, nonce = contract.get("contract_id"), contract.get("nonce")
    if not (isinstance(cid, str) and re.match(r'^[0-9a-f]{32}$', cid)): codes.add("cid")
    if not (isinstance(nonce, str) and re.match(r'^[0-9a-f]{32}$', nonce)): codes.add("nonce")
    parties = contract.get("parties")
    if not isinstance(parties, list) or len(parties) != 2: codes.add("parties")
    else:
        roles = [p.get("role") if isinstance(p, dict) else None for p in parties]
        if sorted(roles) != ["contractor", "principal"]: codes.add("parties_roles")
    norm_domains = []
    if isinstance(parties, list):
        for p in parties:
            if isinstance(p, dict):
                dom = p.get("domain")
                if isinstance(dom, str):
                    nd = normalize_domain(dom)
                    if nd: norm_domains.append(nd)
                    else: codes.add("domain_norm")
                else: codes.add("domain_type")
                url = p.get("key_url")
                if not isinstance(url, str) or not url.startswith("https://"): codes.add("url")
                pk = p.get("public_key_ed25519_b64")
                if not is_canonical_b64(pk): codes.add("pk_b64")
                elif len(base64.b64decode(pk)) != 32: codes.add("pk_len")
    if len(norm_domains) == 2 and norm_domains[0] == norm_domains[1]: codes.add("domain_same")
    task = contract.get("task")
    if not isinstance(task, dict): codes.add("task")
    else:
        purp = task.get("purpose")
        if not isinstance(purp, str) or not purp: codes.add("purpose")
        pdg = task.get("payload_digest")
        if pdg is not None and (not isinstance(pdg, str) or not re.match(r'^[0-9a-f]{64}$', pdg)): codes.add("pdg")
    g = contract.get("grant")
    if not isinstance(g, dict): codes.add("grant")
    else:
        allowed_g_keys = {"authorized_actions", "prohibited_actions", "conditional", "delegation", "data_access", "max_hops", "privacy", "revocation", "finality", "witnesses", "expiry_height", "ordering", "approval_policy", "limits"}
        if any(k not in allowed_g_keys for k in g): codes.add("grant_keys")
        aa, pa = g.get("authorized_actions"), g.get("prohibited_actions")
        if not isinstance(aa, list) or not all(isinstance(x, str) and x for x in aa): codes.add("aa")
        if not isinstance(pa, list) or not all(isinstance(x, str) and x for x in pa): codes.add("pa")
        if isinstance(aa, list) and isinstance(pa, list) and set(aa) & set(pa): codes.add("aa_pa_intersect")
        if "data_access" in g and g["data_access"] is not None:
            da = g["data_access"]
            if not isinstance(da, list) or not all(isinstance(x, str) and x for x in da): codes.add("da")
        for k in ("max_hops", "expiry_height"):
            if k in g and g[k] is not None:
                if not is_int(g[k]) or g[k] < 0: codes.add(k)
        if "delegation" in g and g["delegation"] is not None:
            d = g["delegation"]
            if not isinstance(d, dict) or list(d.keys()) != ["allowed"]: codes.add("delegation_keys")
            else:
                al = d["allowed"]
                if not isinstance(al, list) or not all(isinstance(x, str) and x for x in al): codes.add("delegation_al")
        if "conditional" in g and g["conditional"] is not None:
            cond = g["conditional"]
            if not isinstance(cond, list): codes.add("cond_list")
            else:
                acts = []
                for c in cond:
                    if not isinstance(c, dict): codes.add("cond_dict")
                    else:
                        act = c.get("action")
                        if not isinstance(act, str) or not act: codes.add("cond_act")
                        else: acts.append(act)
                        if "requires" in c and not isinstance(c["requires"], str): codes.add("cond_req")
                if len(acts) != len(set(acts)): codes.add("cond_unique")
        if "finality" in g and g["finality"] is not None:
            fin = g["finality"]
            if not isinstance(fin, dict): codes.add("fin_dict")
            else:
                if any(k not in ("depth", "max_target_bits") for k in fin): codes.add("fin_keys")
                if "depth" in fin:
                    if not is_int(fin["depth"]) or fin["depth"] < 1: codes.add("fin_depth")
                if "max_target_bits" in fin:
                    mtb = fin["max_target_bits"]
                    if not isinstance(mtb, str) or not re.match(r'^[0-9a-f]{8}$', mtb): codes.add("fin_mtb")
                    else:
                        target = decode_compact(mtb)
                        if target is None: codes.add("fin_target")
        if "witnesses" in g and g["witnesses"] is not None:
            wit = g["witnesses"]
            if not isinstance(wit, list): codes.add("wit_list")
            else:
                for w in wit:
                    if not isinstance(w, dict): codes.add("wit_dict")
                    else:
                        name = w.get("name")
                        if not isinstance(name, str) or not name: codes.add("wit_name")
                        pk = w.get("public_key_ed25519_b64")
                        if not is_canonical_b64(pk): codes.add("wit_pk")
                        elif len(base64.b64decode(pk)) != 32: codes.add("wit_pk_len")
        if "privacy" in g and g["privacy"] is not None:
            pr = g["privacy"]
            if not isinstance(pr, str) or not pr: codes.add("privacy")
        if "ordering" in g and g["ordering"] is not None:
            o = g["ordering"]
            if not isinstance(o, dict): codes.add("ord_dict")
            else:
                if any(k != "same_height" for k in o): codes.add("ord_keys")
                if "same_height" in o and o["same_height"] is not None and not isinstance(o["same_height"], str): codes.add("ord_sh")
        if "approval_policy" in g and g["approval_policy"] is not None:
            ap = g["approval_policy"]
            if not isinstance(ap, dict): codes.add("ap_dict")
            else:
                if any(k not in ("allow_unscoped", "approvers") for k in ap): codes.add("ap_keys")
                if "allow_unscoped" in ap and not isinstance(ap["allow_unscoped"], bool): codes.add("ap_au")
                if "approvers" in ap:
                    appr = ap["approvers"]
                    if not isinstance(appr, list) or not (1 <= len(appr) <= 16): codes.add("appr_list")
                    else:
                        n_set, pk_set = set(), set()
                        for a in appr:
                            if not isinstance(a, dict): codes.add("appr_dict")
                            else:
                                if any(k not in ("name", "public_key_ed25519_b64", "actions") for k in a): codes.add("appr_keys")
                                name = a.get("name")
                                pk = a.get("public_key_ed25519_b64")
                                acts = a.get("actions")
                                if not isinstance(name, str) or not name: codes.add("appr_name")
                                else: n_set.add(name)
                                if not is_canonical_b64(pk) or len(base64.b64decode(pk)) != 32: codes.add("appr_pk")
                                else: pk_set.add(pk)
                                if not isinstance(acts, list) or not acts: codes.add("appr_acts")
                                else:
                                    for x in acts:
                                        if not isinstance(x, str) or not x: codes.add("appr_act_str")
                                        else:
                                            conds = g.get("conditional", [])
                                            c_acts = [c.get("action") for c in conds if isinstance(c, dict)] if isinstance(conds, list) else []
                                            if x not in c_acts: codes.add("appr_act_missing")
                                    if len(acts) != len(set(acts)): codes.add("appr_act_unique")
                        if len(n_set) != len(appr): codes.add("appr_name_unique")
                        if len(pk_set) != len(appr): codes.add("appr_pk_unique")
        if "revocation" in g and g["revocation"] is not None:
            rev = g["revocation"]
            if not isinstance(rev, dict): codes.add("rev_dict")
            else:
                ea = rev.get("effective_at")
                if ea not in ("anchor", "delivery_ack"): codes.add("rev_ea")
                if any(k not in ("effective_at", "ack_window") for k in rev): codes.add("rev_keys")
                if "ack_window" in rev:
                    if not is_int(rev["ack_window"]) or rev["ack_window"] < 1: codes.add("rev_aw")
    if not check_numbers(contract): codes.add("numbers")
    if not check_printable_keys(contract): codes.add("keys_printable")
    est = contract.get("establishes")
    if not isinstance(est, list) or not est or not all(isinstance(x, str) for x in est): codes.add("est")
    else:
        bad_pats = [r'\bperformed\b', r'\bdeliver(ed|y)\b', r'\bmoney (moved|was sent)\b', r'\bfunds? (moved|were sent|were transferred)\b', r'\bpaid\b(?!\s+for\s+(this|the)\s+record)', r'\bpayment (was|has been) (made|completed|settled|received)\b', r'\bcontract\b', r'\bbinding\b', r'\bguarantee', r'\bescrow\b', r'\bcustody\b', r'\bsolvent\b', r'\blawful\b', r'\bfair\b', r'\bcertified\b']
        for e in est:
            for pat in bad_pats:
                if re.search(pat, e, re.IGNORECASE): codes.add("est_match")
    dne = contract.get("does_not_establish")
    if not isinstance(dne, list) or not dne or not all(isinstance(x, str) for x in dne): codes.add("dne")
    else:
        dne_text = " ".join(dne).lower()
        if not (("runtime" in dne_text or "enforce" in dne_text) and ("judge" in dne_text or "liability" in dne_text or "fault" in dne_text) and "deviat" in dne_text and "legal" in dne_text): codes.add("dne_groups")
    sigs = contract.get("signatures")
    if not isinstance(sigs, list): codes.add("sigs_list")
    else:
        party_sigs = {0: False, 1: False}
        contract_signing_bytes = b"a2a-contract-v0\n" + canonical({k:v for k,v in contract.items() if k != "signatures"})
        for s in sigs:
            if not isinstance(s, dict): codes.add("sig_dict"); continue
            dom = s.get("domain")
            if not isinstance(dom, str): codes.add("sig_dom"); continue
            nd = normalize_domain(dom)
            idx = -1
            if isinstance(parties, list) and len(parties) == 2:
                for i, p in enumerate(parties):
                    if isinstance(p, dict) and isinstance(p.get("domain"), str) and normalize_domain(p.get("domain")) == nd:
                        idx = i
            if idx == -1: codes.add("sig_dom_match"); continue
            sig_b64 = s.get("signature")
            pk_b64 = parties[idx].get("public_key_ed25519_b64")
            if verify_sig(pk_b64, sig_b64, contract_signing_bytes) != True: codes.add("sig_verify")
            else: party_sigs[idx] = True
        if not party_sigs[0] or not party_sigs[1]: codes.add("sig_missing")
    return len(codes) == 0, codes

def check_settleable(contract):
    reasons = set()
    g = contract.get("grant", {})
    def check_action_name(a):
        if not isinstance(a, str) or not re.match(r'^[a-z][a-z0-9_.:-]{0,63}$', a): reasons.add("grant_action_name_invalid")
    for a in g.get("authorized_actions", []): check_action_name(a)
    for a in g.get("prohibited_actions", []): check_action_name(a)
    for c in g.get("conditional", []):
        if isinstance(c, dict): check_action_name(c.get("action"))
    wit = g.get("witnesses", [])
    if isinstance(wit, list):
        if len(wit) > 32: reasons.add("too_many_witnesses")
        names, keys = [], []
        for w in wit:
            if isinstance(w, dict):
                names.append(w.get("name"))
                keys.append(w.get("public_key_ed25519_b64"))
        if len(names) != len(set(names)): reasons.add("key_conflict")
        all_keys = []
        parties = contract.get("parties", [])
        if isinstance(parties, list):
            for p in parties:
                if isinstance(p, dict): all_keys.append(p.get("public_key_ed25519_b64"))
        all_keys.extend(keys)
        decoded_keys = []
        for k in all_keys:
            if is_canonical_b64(k):
                try:
                    dec = base64.b64decode(k)
                    if len(dec) == 32: decoded_keys.append(dec)
                except: pass
        for i in range(len(decoded_keys)):
            for j in range(i+1, len(decoded_keys)):
                if decoded_keys[i] == decoded_keys[j]: reasons.add("key_conflict")
    ord_ = g.get("ordering", {})
    if isinstance(ord_, dict) and "same_height" in ord_:
        sh = ord_["same_height"]
        if sh is not None and sh != "conservative": reasons.add("tie_policy_refused")
    rev = g.get("revocation")
    if isinstance(rev, dict):
        ea = rev.get("effective_at")
        if ea not in ("anchor", "delivery_ack"): reasons.add("revocation_policy_not_recomputable")
        if ea == "delivery_ack":
            aw = rev.get("ack_window")
            if not is_int(aw) or aw < 1: reasons.add("ack_window_missing")
    fin = g.get("finality")
    if not isinstance(fin, dict) or "depth" not in fin or not is_int(fin["depth"]) or fin["depth"] < 1: reasons.add("finality_policy_missing")
    eh = g.get("expiry_height")
    if eh is not None and (not is_int(eh) or eh < 0): reasons.add("bad_expiry_height")
    ap = g.get("approval_policy")
    if isinstance(ap, dict) and ap.get("allow_unscoped"): reasons.add("unscoped_approvals_refused")
    return reasons

def check_parent_narrowing(child, parent):
    pc = child.get("parent_contract")
    if not isinstance(pc, dict) or pc.get("contract_id") != parent.get("contract_id"): return False
    C, P = child.get("grant", {}), parent.get("grant", {})
    for a in C.get("authorized_actions") or []:
        if a not in (P.get("authorized_actions") or []): return False
    for a in P.get("prohibited_actions") or []:
        if a not in (C.get("prohibited_actions") or []): return False
    for a in C.get("data_access") or []:
        if a not in (P.get("data_access") or []): return False
    if "max_hops" in P and is_int(P["max_hops"]):
        C_mh = C.get("max_hops")
        if not is_int(C_mh) or C_mh > P["max_hops"] - 1: return False
    for a in (C.get("delegation") or {}).get("allowed") or []:
        if a not in ((P.get("delegation") or {}).get("allowed") or []): return False
    C_cond, P_cond = C.get("conditional") or [], P.get("conditional") or []
    C_cond_dict = {c.get("action"): c.get("requires") for c in C_cond}
    C_pa = C.get("prohibited_actions") or []
    C_aa = C.get("authorized_actions") or []
    for p in P_cond:
        a, r = p.get("action"), p.get("requires")
        if a in C_pa or (a not in C_aa and a not in C_cond_dict): continue
        if a not in C_cond_dict or C_cond_dict[a] != r: return False
    P_cond_acts = [p.get("action") for p in P_cond]
    P_aa = P.get("authorized_actions") or []
    for a in C_cond_dict:
        if a not in P_aa and a not in P_cond_acts: return False
    if "expiry_height" in P and is_int(P["expiry_height"]):
        C_eh = C.get("expiry_height")
        if not is_int(C_eh) or C_eh > P["expiry_height"]: return False
    P_rev = P.get("revocation")
    if isinstance(P_rev, dict):
        C_rev = C.get("revocation")
        if not isinstance(C_rev, dict): return False
        m, C_ea = P_rev.get("effective_at"), C_rev.get("effective_at")
        if m == "anchor" and C_ea != "anchor": return False
        elif m == "delivery_ack":
            if C_ea not in ("anchor", "delivery_ack"): return False
            if C_ea == "delivery_ack" and is_int(P_rev.get("ack_window")):
                cw = C_rev.get("ack_window")
                if not is_int(cw) or cw > P_rev["ack_window"]: return False
        elif m not in ("anchor", "delivery_ack"): return False
    P_fin = P.get("finality")
    if isinstance(P_fin, dict):
        C_fin = C.get("finality")
        if not isinstance(C_fin, dict): return False
        if "depth" in P_fin and is_int(P_fin["depth"]):
            cd = C_fin.get("depth")
            if not is_int(cd) or cd < P_fin["depth"]: return False
        if "max_target_bits" in P_fin:
            pt = decode_compact(P_fin["max_target_bits"])
            if pt is not None:
                ctb = C_fin.get("max_target_bits")
                if not isinstance(ctb, str): return False
                ct = decode_compact(ctb)
                if ct is None or ct > pt: return False
    C_wit_keys = [w.get("public_key_ed25519_b64") for w in (C.get("witnesses") or []) if isinstance(w, dict)]
    for pw in P.get("witnesses") or []:
        if isinstance(pw, dict):
            pk = pw.get("public_key_ed25519_b64")
            if isinstance(pk, str) and pk not in C_wit_keys: return False
    for k in ("privacy", "ordering"):
        if k in P and P[k] is not None and (k not in C or C[k] != P[k]): return False
    if (C.get("approval_policy") or {}).get("allow_unscoped") == True and (P.get("approval_policy") or {}).get("allow_unscoped") != True: return False
    C_appr_can = set(canonical(a) for a in ((C.get("approval_policy") or {}).get("approvers") or []))
    P_appr_can = set(canonical(a) for a in ((P.get("approval_policy") or {}).get("approvers") or []))
    if C_appr_can != P_appr_can: return False
    return True

def check_strict_terms(contract, parent_contract_raw):
    reasons = set()
    sigs = contract.get("signatures", [])
    if isinstance(sigs, list):
        for s in sigs:
            if isinstance(s, dict):
                sig_b64 = s.get("signature")
                if is_canonical_b64(sig_b64):
                    try:
                        dec = base64.b64decode(sig_b64)
                        if len(dec) == 64 and not is_strict_sig_only(dec): reasons.add("contract_signature_not_strict")
                    except: pass
    bond = contract.get("bond")
    if bond is not None:
        if not isinstance(bond, dict) or "amount" not in bond or not is_int(bond["amount"]) or not (1 <= bond["amount"] <= 9007199254740991): reasons.add("bond_malformed")
    pc = contract.get("parent_contract")
    if pc is not None:
        if parent_contract_raw is None: reasons.add("parent_not_supplied")
        else:
            p_ok, _ = check_door(parent_contract_raw)
            if not isinstance(parent_contract_raw, dict) or not p_ok or not check_parent_narrowing(contract, parent_contract_raw): reasons.add("parent_narrowing_failed")
    return reasons

def check_view(contract, view):
    reasons = set()
    mtb = contract.get("grant", {}).get("finality", {}).get("max_target_bits")
    floor = decode_compact(mtb) if isinstance(mtb, str) and re.match(r'^[0-9a-f]{8}$', mtb) else None
    if floor is None: reasons.add("chain_view_rejected")
    lb = contract.get("lower_bound")
    if not isinstance(lb, dict) or not is_int(lb.get("height")) or not (isinstance(lb.get("hash"), str) and re.match(r'^[0-9a-f]{64}$', lb["hash"])): reasons.add("chain_view_rejected")
    headers = view.get("headers")
    if not isinstance(headers, list) or not headers: reasons.add("chain_view_rejected")
    if "chain_view_rejected" not in reasons:
        prev_hash, found_lb = None, False
        for i, h in enumerate(headers):
            if not isinstance(h, dict) or not is_int(h.get("height")) or h["height"] < 0: reasons.add("chain_view_rejected"); break
            hx = h.get("hex")
            if not isinstance(hx, str) or not re.match(r'^[0-9a-f]{160}\n?$', hx): reasons.add("chain_view_rejected"); break
            hx_clean = hx.strip()
            if i > 0 and h["height"] != headers[i-1]["height"] + 1: reasons.add("chain_view_rejected"); break
            raw = bytes.fromhex(hx_clean)
            if i > 0 and raw[4:36][::-1].hex() != prev_hash: reasons.add("chain_view_rejected"); break
            target = decode_compact(raw[72:76][::-1].hex())
            if target is None or target > floor: reasons.add("chain_view_rejected"); break
            h_hash = hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1]
            if int.from_bytes(h_hash[::-1], 'big') > target: reasons.add("chain_view_rejected"); break
            if h["height"] == lb["height"] and h_hash.hex() == lb["hash"]: found_lb = True
            prev_hash = h_hash.hex()
        if not found_lb: reasons.add("chain_view_rejected")
    if isinstance(view, dict) and isinstance(view.get("headers"), list):
        strict = is_strict(view)
        for h in view["headers"]:
            if isinstance(h, dict):
                hx = h.get("hex")
                if not isinstance(hx, str) or len(hx) != 160 or not re.match(r'^[0-9a-f]{160}$', hx): strict = False
            else: strict = False
        if not strict: reasons.add("view_not_strict")
    if "chain_view_rejected" not in reasons and len(headers) > 200000: reasons.add("input_too_large")
    return reasons

def check_anchor(rec, view_hashes, view_roots, lb_height):
    anchor = rec.get("anchor")
    if not isinstance(anchor, dict): return "anchor_incomplete", None
    h, bh = anchor.get("height"), anchor.get("block_hash")
    if not is_int(h) or h < 0 or not isinstance(bh, str) or not re.match(r'^[0-9a-f]{64}$', bh): return "anchor_incomplete", None
    if h < lb_height: return "anchor_below_lower_bound", None
    if h not in view_hashes: return "anchor_beyond_observed_chain", None
    if bh != view_hashes[h]: return "orphaned", None
    proof = anchor.get("proof")
    if not isinstance(proof, list) or not proof or len(proof) > 512: return "anchor_proof_invalid", None
    rec_copy = {k:v for k,v in rec.items() if k != "anchor"}
    curr = hashlib.sha256(canonical(rec_copy)).digest()
    hexlify_idx = -1
    for i, op in enumerate(proof):
        if not isinstance(op, dict): return "anchor_proof_invalid", None
        o = op.get("op")
        if o == "sha256": curr = hashlib.sha256(curr).digest()
        elif o == "hexlify":
            curr = curr.hex().encode('ascii')
            if hexlify_idx == -1: hexlify_idx = i
            else: return "anchor_batch_leg_refused", None
        elif o in ("append", "prepend"):
            hx = op.get("hex")
            if not isinstance(hx, str) or not re.match(r'^([0-9a-f]{2})*$', hx) or len(hx) > 8192: return "anchor_proof_invalid", None
            hx_bytes = bytes.fromhex(hx)
            if o == "append": curr = curr + hx_bytes
            else: curr = hx_bytes + curr
        else: return "anchor_proof_invalid", None
        if len(curr) > 65536: return "anchor_proof_invalid", None
    if curr != view_roots[h]: return "anchor_proof_invalid", None
    if hexlify_idx != -1:
        if hexlify_idx != 0: return "anchor_batch_leg_refused", None
        prepends, appends, sha_seen = [], [], False
        for op in proof[1:]:
            o = op.get("op")
            if o == "sha256": sha_seen = True; break
            elif o == "prepend": prepends.insert(0, bytes.fromhex(op["hex"]))
            elif o == "append": appends.append(bytes.fromhex(op["hex"]))
            else: return "anchor_batch_leg_refused", None
        if not sha_seen: return "anchor_batch_leg_refused", None
        batch_bytes = b"".join(prepends) + hashlib.sha256(canonical(rec_copy)).digest().hex().encode('ascii') + b"".join(appends)
        try:
            batch_str = batch_bytes.decode('utf-8')
            depth, in_str, esc = 0, False, False
            for char in batch_str:
                if esc: esc = False; continue
                if char == '"': in_str = not in_str
                elif char == '\\' and in_str: esc = True
                elif not in_str:
                    if char in '[{':
                        depth += 1
                        if depth > 512: raise ValueError()
                    elif char in ']}': depth -= 1
            batch = json.loads(batch_str, cls=StrictJSONDecoder)
            if not isinstance(batch, dict): return "anchor_batch_leg_refused", None
            schema = batch.get("schema")
            if schema not in ("nenrin-agreement-batch-v1", "nenrin-witness-batch-v1", "nenrin-trace-pin-batch-v0"): return "anchor_batch_leg_refused", None
            recs = batch.get("records")
            if not isinstance(recs, list): return "anchor_batch_leg_refused", None
            if "count" in batch and batch["count"] != len(recs): return "anchor_batch_leg_refused", None
            target_sha = hashlib.sha256(canonical(rec_copy)).hexdigest()
            matches = [r for r in recs if isinstance(r, dict) and r.get("sha") == target_sha]
            if len(matches) != 1: return "anchor_batch_leg_refused", None
            rec_in_batch = matches[0]
            if schema == "nenrin-agreement-batch-v1":
                kind_map = {"a2a-execution-v0": "execution"}
                rec_schema = rec.get("schema")
                if rec_schema not in kind_map or rec_in_batch.get("kind") != kind_map[rec_schema]: return "anchor_batch_leg_refused", None
                if "schema" in rec_in_batch and rec_in_batch["schema"] != rec_schema: return "anchor_batch_leg_refused", None
            if batch_bytes[sum(len(p) for p in prepends):][:64] != target_sha.encode('ascii'): return "anchor_batch_leg_refused", None
        except: return "anchor_batch_leg_refused", None
    return "accepted", h

def check_conformance(ev):
    schema = ev.get("schema")
    if schema == "a2a-execution-v0":
        allowed = {"schema", "contract_ref", "performed_actions", "approvals", "delegated_to", "nenrin_ref", "outcomes", "anchor", "signatures"}
        if any(k not in allowed for k in ev): return False
        pa = ev.get("performed_actions")
        if not isinstance(pa, list) or not all(isinstance(x, str) for x in pa): return False
        out = ev.get("outcomes")
        if out is not None:
            if not isinstance(out, dict): return False
            for k, v in out.items():
                if k not in pa or v not in ("ok", "error", "timeout", "partial"): return False
        if len(pa) > 256: return False
        for a in pa:
            if not re.match(r'^[a-z][a-z0-9_.:-]{0,63}$', a): return False
        appr = ev.get("approvals", [])
        if isinstance(appr, list):
            for a in appr:
                if isinstance(a, dict):
                    act = a.get("action")
                    if not isinstance(act, str) or not re.match(r'^[a-z][a-z0-9_.:-]{0,63}$', act): return False
                else: return False
    elif schema == "a2a-revocation-v0":
        allowed = {"schema", "contract_ref", "revoked_by", "anchor", "signatures"}
        if any(k not in allowed for k in ev): return False
    elif schema == "a2a-revocation-ack-v0":
        allowed = {"schema", "contract_ref", "revocation_sha256", "acked_by", "anchor", "signatures"}
        if any(k not in allowed for k in ev): return False
    return True

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Missing vector_dir"}))
        sys.exit(2)
        
    vec_dir = sys.argv[1]
    
    try:
        contract = load_json(os.path.join(vec_dir, "contract.json"))
        view = load_json(os.path.join(vec_dir, "view.json"))
        events = []
        events_dir = os.path.join(vec_dir, "events")
        if os.path.isdir(events_dir):
            for f in os.listdir(events_dir):
                events.append(load_json(os.path.join(events_dir, f)))
        nenrin_records = []
        nenrin_dir = os.path.join(vec_dir, "nenrin")
        if os.path.isdir(nenrin_dir):
            for f in os.listdir(nenrin_dir):
                nenrin_records.append(load_json(os.path.join(nenrin_dir, f)))
        parent_contract = None
        parent_path = os.path.join(vec_dir, "parent.json")
        if os.path.exists(parent_path):
            parent_contract = load_json(parent_path)
    except Exception as e:
        print(json.dumps({"error": "parse error"}))
        sys.exit(2)
        
    if not isinstance(events, list):
        print(json.dumps({
            "contract_sha256": None if not isinstance(contract, dict) else hashlib.sha256(b"a2a-contract-v0\n" + canonical({k:v for k,v in contract.items() if k != "signatures"})).hexdigest(),
            "verdict": "underspecified", "status": "undetermined", "bond_outcome": "undetermined",
            "deviation_codes": [], "underspecified_reasons": ["input_not_settleable"], "event_set": [], "dispositions": {}
        }))
        sys.exit(0)

    contract_sha256 = None
    if isinstance(contract, dict):
        contract_sha256 = hashlib.sha256(b"a2a-contract-v0\n" + canonical({k:v for k,v in contract.items() if k != "signatures"})).hexdigest()
        
    door_ok, door_codes = check_door(contract)
    underspecified = set()
    if not door_ok:
        underspecified.add("contract_not_verified")
    else:
        underspecified.update(check_settleable(contract))
        
    if isinstance(contract, dict):
        underspecified.update(check_strict_terms(contract, parent_contract))
        
    view_reasons = check_view(contract, view)
    underspecified.update(view_reasons)
    
    stop_early = not door_ok or ("chain_view_rejected" in view_reasons) or ("input_too_large" in view_reasons)
    
    view_hashes, view_roots = {}, {}
    if not stop_early and isinstance(view, dict) and isinstance(view.get("headers"), list):
        for h in view["headers"]:
            if isinstance(h, dict) and is_int(h.get("height")) and isinstance(h.get("hex"), str):
                hx_clean = h.get("hex").strip()
                raw = bytes.fromhex(hx_clean)
                h_hash = hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1].hex()
                root = raw[36:68]
                view_hashes[h["height"]] = h_hash
                view_roots[h["height"]] = root

    contract_keys = {}
    if door_ok:
        for p in contract.get("parties", []):
            contract_keys[p.get("role")] = p.get("public_key_ed25519_b64")
        for w in contract.get("grant", {}).get("witnesses", []):
            if "witnesses" not in contract_keys: contract_keys["witnesses"] = {}
            contract_keys["witnesses"][w.get("name")] = w.get("public_key_ed25519_b64")

    dispositions = {}
    event_set = []
    orphaned = []
    devs = set()
    
    if stop_early:
        pass
    else:
        cid = contract.get("contract_id")
        pdg = contract.get("task", {}).get("payload_digest")
        seen_shas = set()
        bound_records = []
        for ev in events:
            if not isinstance(ev, dict): continue
            schema = ev.get("schema")
            if schema not in ("a2a-execution-v0", "a2a-revocation-v0", "a2a-revocation-ack-v0"): continue
            try: can = canonical(ev)
            except: continue
            rsha = hashlib.sha256(can).hexdigest()
            if rsha in seen_shas: continue
            seen_shas.add(rsha)
            cref = ev.get("contract_ref", {}) if isinstance(ev.get("contract_ref"), dict) else {}
            ref_csha, ref_cid, ref_pdg = cref.get("contract_sha256"), cref.get("contract_id"), cref.get("payload_digest")
            if (ref_csha is None) and ref_cid == cid: dispositions[rsha] = "unbound"
            elif ref_csha is None: pass
            elif not isinstance(ref_csha, str) or not re.match(r'^[0-9a-f]{64}$', ref_csha): dispositions[rsha] = "inconsistent"
            elif ref_csha != contract_sha256: dispositions[rsha] = "foreign"
            elif ref_cid != cid: dispositions[rsha] = "inconsistent"
            elif pdg is not None and ref_pdg != pdg: dispositions[rsha] = "inconsistent"
            else: bound_records.append((rsha, ev))
            
        if len(bound_records) > 10000:
            underspecified.add("input_too_large")
        else:
            candidates = []
            for rsha, ev in bound_records:
                rs_bytes = get_record_signing_bytes(ev)
                b_strict = is_body_strict(ev)
                s_strict, s_lax = check_record_signed(ev, contract_keys)
                a_strict = is_anchor_strict(ev.get("anchor")) if "anchor" in ev else True
                if not s_strict and not b_strict: dispositions[rsha] = "record_not_strict"
                elif not s_strict and s_lax: dispositions[rsha] = "signature_not_strict"
                elif not s_strict: dispositions[rsha] = "rejected"
                elif s_strict and not b_strict:
                    dispositions[rsha] = "record_not_strict"
                    underspecified.add("record_not_strict")
                elif s_strict and not a_strict: candidates.append((rsha, ev, rs_bytes, "a_not_strict"))
                elif ev.get("schema") == "a2a-revocation-v0" and not isinstance(contract.get("grant", {}).get("revocation"), dict): dispositions[rsha] = "revocation_not_provided_for"
                else: candidates.append((rsha, ev, rs_bytes, "kept"))
                
            validly_anchoring_rs_bytes = set()
            lb_height = contract.get("lower_bound", {}).get("height", 0)
            for rsha, ev, rs_bytes, status in candidates:
                if status == "kept":
                    res, _ = check_anchor(ev, view_hashes, view_roots, lb_height)
                    if res == "accepted": validly_anchoring_rs_bytes.add(rs_bytes)
                    
            kept_records = []
            for rsha, ev, rs_bytes, status in candidates:
                if status == "a_not_strict":
                    if rs_bytes in validly_anchoring_rs_bytes: dispositions[rsha] = "anchor_not_strict"
                    else:
                        underspecified.add("anchor_not_strict")
                        kept_records.append((rsha, ev, rs_bytes))
                elif status == "kept": kept_records.append((rsha, ev, rs_bytes))
                
            groups = {}
            for rsha, ev, rs_bytes in kept_records:
                groups.setdefault(rs_bytes, []).append((rsha, ev))
            collapsed = []
            for rs_bytes, grp in groups.items():
                if len(grp) > 1:
                    valid = []
                    for rsha, ev in grp:
                        res, _ = check_anchor(ev, view_hashes, view_roots, lb_height)
                        if res == "accepted": valid.append((rsha, ev))
                    if valid:
                        valid.sort(key=lambda x: (x[1].get("anchor", {}).get("height", 0), x[0]))
                        kept = valid[0]
                        collapsed.append(kept)
                        for rsha, ev in grp:
                            if rsha != kept[0]: dispositions[rsha] = "duplicate_dropped"
                    else: collapsed.extend(grp)
                else: collapsed.extend(grp)
                
            auth_kept = []
            for rsha, ev in collapsed:
                if ev.get("schema") == "a2a-revocation-v0" and ev.get("revoked_by") != "principal": dispositions[rsha] = "ignored"
                else: auth_kept.append((rsha, ev))
                
            while True:
                new_reject = False
                next_kept = []
                for rsha, ev in auth_kept:
                    if check_conformance(ev): next_kept.append((rsha, ev))
                    else:
                        is_charge = False
                        if ev.get("schema") == "a2a-execution-v0":
                            for s in (ev.get("signatures") or []):
                                if isinstance(s, dict) and s.get("role") == "contractor":
                                    pk = contract_keys.get("contractor")
                                    if pk and verify_sig(pk, s.get("sig_b64"), get_record_signing_bytes(ev)) == True:
                                        is_charge = True; break
                        if is_charge:
                            ev["_is_nonconforming_charge"] = True
                            next_kept.append((rsha, ev))
                        else:
                            dispositions[rsha] = "rejected"
                            new_reject = True
                auth_kept = next_kept
                if not new_reject: break
                
            for rsha, ev in auth_kept:
                res, h = check_anchor(ev, view_hashes, view_roots, lb_height)
                dispositions[rsha] = res
                if res in ("anchor_incomplete", "anchor_beyond_observed_chain", "anchor_proof_invalid", "anchor_batch_leg_refused", "anchor_below_lower_bound"): underspecified.add(res)
                elif res == "accepted":
                    event_set.append({"kind": "execution" if ev.get("schema") == "a2a-execution-v0" else "revocation" if ev.get("schema") == "a2a-revocation-v0" else "revocation_ack", "sha256": rsha, "height": h, "record": ev})
                elif res == "orphaned": orphaned.append(ev.get("anchor", {}).get("height", 0))
                
            event_set.sort(key=lambda x: (x["height"], x["sha256"]))
            
            walks = {}
            if nenrin_records and isinstance(nenrin_records, list):
                for w in nenrin_records:
                    if not is_strict(w): continue
                    try: walks[hashlib.sha256(canonical(w)).hexdigest()] = w
                    except: pass
                for rsha, ev in auth_kept:
                    if ev.get("schema") == "a2a-execution-v0":
                        nref = ev.get("nenrin_ref")
                        if isinstance(nref, str) and nref in walks:
                            ctx = walks[nref].get("context")
                            if isinstance(ctx, dict) and ctx.get("contract_sha256") is not None and ctx["contract_sha256"] != contract_sha256: devs.add("evidence_names_other_contract")
                        elif isinstance(nref, str):
                            for raw_w in nenrin_records:
                                if not is_strict(raw_w):
                                    try:
                                        if hashlib.sha256(canonical(raw_w)).hexdigest() == nref: underspecified.add("walk_not_strict")
                                    except: pass

            g = contract.get("grant", {})
            rev_eff = []
            ea = g.get("revocation", {}).get("effective_at")
            aw = g.get("revocation", {}).get("ack_window", 0)
            acks = [e for e in event_set if e["kind"] == "revocation_ack"]
            for r in [e for e in event_set if e["kind"] == "revocation"]:
                eff = r["height"]
                if ea == "delivery_ack":
                    eff += aw
                    for a in acks:
                        rs = a["record"].get("revocation_sha256")
                        if rs == hashlib.sha256(canonical({k:v for k,v in r["record"].items() if k not in ("signatures", "anchor")})).hexdigest() or rs == r["sha256"]: eff = min(eff, a["height"])
                rev_eff.append((eff, r["sha256"]))
            rev_eff.sort()

            consumed_nonces = set()
            counted_approvals = []
            for ev in event_set:
                if ev["kind"] != "execution": continue
                rsha, h = ev["sha256"], ev["height"]
                for appr in (ev["record"].get("approvals") or []):
                    classified = "forged"
                    if isinstance(appr, dict) and contract_keys.get("principal"):
                        pk, vuh, nonce, su, csha_appr, sig_b64 = contract_keys.get("principal"), appr.get("valid_until_height"), appr.get("nonce"), appr.get("single_use"), appr.get("contract_sha256"), appr.get("sig_b64")
                        if is_int(vuh) and vuh >= 0 and isinstance(nonce, str) and len(nonce)==32 and re.match(r'^[0-9a-f]{32}$', nonce) and isinstance(su, bool) and isinstance(csha_appr, str) and len(csha_appr)==64:
                            if verify_sig(pk, sig_b64, b"a2a-approval-v2\n" + canonical({"contract_sha256": csha_appr, "action": appr.get("action"), "valid_until_height": vuh, "nonce": nonce, "single_use": su})) == True: classified = "counted" if csha_appr == contract_sha256 else "other_terms"
                        if classified == "forged":
                            cid_c, pdg_c = contract.get("contract_id"), contract.get("task", {}).get("payload_digest")
                            if (is_int(vuh) and vuh >= 0 and isinstance(nonce, str) and len(nonce)==32 and re.match(r'^[0-9a-f]{32}$', nonce) and isinstance(su, bool)) and verify_sig(pk, sig_b64, b"a2a-approval-v1\n" + canonical({"contract_id": cid_c, "payload_digest": pdg_c, "action": appr.get("action"), "valid_until_height": vuh, "nonce": nonce, "single_use": su})) == True: classified = "label_bound"
                            elif verify_sig(pk, sig_b64, b"a2a-approval-v0\n" + canonical({"contract_id": cid_c, "payload_digest": pdg_c, "action": appr.get("action")})) == True: classified = "label_bound"
                    if classified == "forged": devs.add("forged_approval")
                    elif classified == "counted": counted_approvals.append({"appr": appr, "carried_by": rsha, "carried_h": h})

            eh = g.get("expiry_height")
            cond_dict = {c.get("action"): c for c in g.get("conditional", []) if isinstance(c, dict)}
            for ev in [e for e in event_set if e["kind"] == "execution"]:
                rec, h, rsha = ev["record"], ev["height"], ev["sha256"]
                if rec.get("_is_nonconforming_charge"): devs.add("nonconforming_record")
                is_revoked = any(eff <= h for eff, _ in rev_eff)
                pa = rec.get("performed_actions", [])
                if is_revoked:
                    if pa: devs.add("revoked")
                    continue
                for a in pa:
                    if eh is not None and h > eh: devs.add("after_expiry")
                    if a in g.get("prohibited_actions", []): devs.add("prohibited"); continue
                    if a in cond_dict:
                        approved = False
                        for ca in counted_approvals:
                            if ca["appr"].get("action") != a: continue
                            if ca["carried_by"] != rsha and ca["carried_h"] >= h: continue
                            if h > ca["appr"].get("valid_until_height"): continue
                            if ca["appr"].get("single_use") and ca["appr"].get("nonce") in consumed_nonces: continue
                            approved = True
                            if ca["appr"].get("single_use"): consumed_nonces.add(ca["appr"].get("nonce"))
                            break
                        if not approved: devs.add("conditional")
                        continue
                    if a not in g.get("authorized_actions", []): devs.add("unauthorized")
                dt = rec.get("delegated_to", [])
                allowed_dt = (g.get("delegation") or {}).get("allowed") or []
                for d in dt:
                    if d not in allowed_dt: devs.add("delegation")
            
            req = contract.get("requirements", {})
            if isinstance(req, dict) and req.get("evidence") == "nenrin_required":
                for ev in event_set:
                    if ev["kind"] == "execution":
                        nref = ev["record"].get("nenrin_ref")
                        if not isinstance(nref, str) or not re.match(r'^[0-9a-f]{64}$', nref): devs.add("evidence_missing")

    verdict = "underspecified" if underspecified else "deviation" if devs else "nothing_to_settle" if not event_set else "within_grant"
    status = "undetermined"
    if verdict != "underspecified":
        T = view["headers"][-1]["height"] if (isinstance(view, dict) and isinstance(view.get("headers"), list) and view["headers"]) else 0
        horizon = T - (contract.get("grant", {}).get("finality", {}).get("depth", 1)) + 1
        status = "provisional" if any(e["height"] > horizon for e in event_set) or any(h > horizon for h in orphaned) else "final"
        
    bond = contract.get("bond") if isinstance(contract, dict) else None
    bond_outcome = "n/a"
    if bond is not None:
        if "bond_malformed" in underspecified:
            bond_outcome = "undetermined" if isinstance(bond, dict) and bond.get("amount") else "n/a"
        elif verdict == "underspecified": bond_outcome = "undetermined"
        elif status == "provisional": bond_outcome = "pending_finality"
        elif verdict in ("within_grant", "nothing_to_settle"): bond_outcome = "held"
        elif verdict == "deviation": bond_outcome = "forfeited"

    out_event_set = [{"kind": e["kind"], "sha256": e["sha256"], "height": e["height"]} for e in event_set]
    
    print(json.dumps({
        "contract_sha256": contract_sha256, "verdict": verdict, "status": status, "bond_outcome": bond_outcome,
        "deviation_codes": sorted(list(devs)) if verdict == "deviation" else [],
        "underspecified_reasons": sorted(list(underspecified)) if verdict == "underspecified" else [],
        "event_set": out_event_set, "dispositions": dispositions
    }))
