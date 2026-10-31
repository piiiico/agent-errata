#!/usr/bin/env python3
"""MUSUBI settle core v0."""

import base64
import hashlib
import json
import math
import re
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

sys.setrecursionlimit(10000)

MAX_SAFE = 2**53 - 1
P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
I_SQRT = pow(2, (P - 1) // 4, P)

SCHEMAS = ("a2a-execution-v0", "a2a-revocation-v0", "a2a-revocation-ack-v0")
CTX = {
    "a2a-execution-v0": b"a2a-execution-v0\n",
    "a2a-revocation-v0": b"a2a-revocation-v0\n",
    "a2a-revocation-ack-v0": b"a2a-revocation-ack-v0\n",
}
KIND = {
    "a2a-execution-v0": "execution",
    "a2a-revocation-v0": "revocation",
    "a2a-revocation-ack-v0": "revocation_ack",
}
GRANT_KEYS = {
    "authorized_actions",
    "prohibited_actions",
    "conditional",
    "delegation",
    "data_access",
    "max_hops",
    "privacy",
    "revocation",
    "finality",
    "witnesses",
    "expiry_height",
    "ordering",
    "approval_policy",
    "limits",
}
EXEC_FIELDS = {
    "schema",
    "contract_ref",
    "performed_actions",
    "approvals",
    "delegated_to",
    "nenrin_ref",
    "outcomes",
    "anchor",
    "signatures",
}
REV_FIELDS = {"schema", "contract_ref", "revoked_by", "anchor", "signatures"}
ACK_FIELDS = {
    "schema",
    "contract_ref",
    "revocation_sha256",
    "acked_by",
    "anchor",
    "signatures",
}
FOUR_TWO = {
    "authorized_actions_missing",
    "grant_action_name_invalid",
    "too_many_witnesses",
    "witness_key_invalid",
    "key_conflict",
    "tie_policy_refused",
    "revocation_policy_not_recomputable",
    "ack_window_missing",
    "finality_policy_missing",
    "bad_expiry_height",
    "unscoped_approvals_refused",
}
ACTION_RE = re.compile(r"^[a-z][a-z0-9_.:-]{0,63}$")
LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
EST_RES = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bperformed\b",
        r"\bdeliver(ed|y)\b",
        r"\bmoney (moved|was sent)\b",
        r"\bfunds? (moved|were sent|were transferred)\b",
        r"\bpaid\b(?!\s+for\s+(this|the)\s+record)",
        r"\bpayment (was|has been) (made|completed|settled|received)\b",
        r"\bcontract\b",
        r"\bbinding\b",
        r"\bguarantee",
        r"\bescrow\b",
        r"\bcustody\b",
        r"\bsolvent\b",
        r"\blawful\b",
        r"\bfair\b",
        r"\bcertified\b",
    )
]
BATCH_SCHEMAS = {
    "nenrin-agreement-batch-v1",
    "nenrin-witness-batch-v1",
    "nenrin-trace-pin-batch-v0",
}
OUTCOMES = {"ok", "error", "timeout", "partial"}
HEX = set("0123456789abcdef")
_POINT_CACHE = {}


class InputError(Exception):
    pass


class JInt(int):
    pass


class JFloat(float):
    pass


class SpanStr(str):
    def __new__(cls, value, start_byte, escaped):
        obj = str.__new__(cls, value)
        obj.start_byte = start_byte
        obj.escaped = escaped
        return obj


def emit(obj, code):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.buffer.write(data.encode("utf-8") + b"\n")
    raise SystemExit(code)


def fail(reason):
    emit({"error": reason}, 2)


def too_deep(text):
    depth = 0
    i = 0
    n = len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
        elif c in "{[":
            depth += 1
            if depth > 512:
                return True
        i += 1
    return False


def parse_json(text):
    if too_deep(text):
        raise InputError("nesting too deep")

    def pairs(ps):
        d = {}
        for k, v in ps:
            if k in d:
                raise InputError("duplicate key")
            d[k] = v
        return d

    def pint(s):
        digits = s[1:] if s.startswith("-") else s
        if len(digits) > 4300:
            raise InputError("integer too long")
        return JInt(s)

    def pfloat(s):
        return JFloat(s)

    def pconst(s):
        if s == "NaN":
            return JFloat("nan")
        if s == "Infinity":
            return JFloat("inf")
        if s == "-Infinity":
            return JFloat("-inf")
        raise InputError("invalid json")

    try:
        return json.loads(
            text,
            object_pairs_hook=pairs,
            parse_int=pint,
            parse_float=pfloat,
            parse_constant=pconst,
        )
    except InputError:
        raise
    except RecursionError:
        raise InputError("nesting too deep")
    except Exception:
        raise InputError("invalid json")


def canon_string(s):
    out = ['"']
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        o = ord(c)
        if c == '"':
            out.append('\\"')
        elif c == "\\":
            out.append("\\\\")
        elif c == "\b":
            out.append("\\b")
        elif c == "\f":
            out.append("\\f")
        elif c == "\n":
            out.append("\\n")
        elif c == "\r":
            out.append("\\r")
        elif c == "\t":
            out.append("\\t")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        elif 0xD800 <= o <= 0xDBFF and i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
            cp = 0x10000 + ((o - 0xD800) << 10) + (ord(s[i + 1]) - 0xDC00)
            out.append(chr(cp))
            i += 2
            continue
        elif 0xD800 <= o <= 0xDFFF:
            out.append("\\u%04x" % o)
        else:
            out.append(c)
        i += 1
    out.append('"')
    return "".join(out)


def canon_text(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(int(v))
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        return repr(float(v))
    if isinstance(v, str):
        return canon_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canon_text(x) for x in v) + "]"
    if isinstance(v, dict):
        items = sorted(v.items(), key=lambda kv: kv[0])
        return "{" + ",".join(canon_string(k) + ":" + canon_text(val) for k, val in items) + "}"
    raise ValueError("cannot canonicalize")


def canonical(v):
    return canon_text(v).encode("utf-8")


def sha256_hex(b):
    return hashlib.sha256(b).hexdigest()


def is_lower_hex(s, n=None):
    if not isinstance(s, str):
        return False
    if n is not None and len(s) != n:
        return False
    return all(c in HEX for c in s)


def hex_pairs(s):
    return isinstance(s, str) and len(s) % 2 == 0 and all(c in HEX for c in s)


def json_int(v):
    if isinstance(v, bool) or not isinstance(v, JInt):
        return None
    return int(v)


def is_int(v, lo=None, hi=None):
    n = json_int(v)
    if n is None:
        return False
    if lo is not None and n < lo:
        return False
    if hi is not None and n > hi:
        return False
    return True


def is_strict(v, depth=0):
    if depth > 512:
        return False
    if v is None or isinstance(v, bool):
        return True
    if isinstance(v, int):
        return -MAX_SAFE <= int(v) <= MAX_SAFE
    if isinstance(v, float):
        return False
    if isinstance(v, str):
        return not any(ord(c) < 0x20 or ord(c) == 0x7F for c in v)
    if isinstance(v, list):
        return all(is_strict(x, depth + 1) for x in v)
    if isinstance(v, dict):
        for k, val in v.items():
            if not isinstance(k, str) or not all(0x20 <= ord(c) <= 0x7E for c in k):
                return False
            if not is_strict(val, depth + 1):
                return False
        return True
    return False


def b64_decode_any(s, n):
    if not isinstance(s, str):
        return None
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        return None
    if len(raw) != n:
        return None
    return raw


def b64_canonical(s, n):
    raw = b64_decode_any(s, n)
    if raw is None:
        return None
    try:
        if base64.b64encode(raw).decode("ascii") != s:
            return None
    except Exception:
        return None
    return raw


def recover_point(b):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    sign = (y >> 255) & 1
    y &= (1 << 255) - 1
    if y >= P:
        return None
    y2 = y * y % P
    u = (y2 - 1) % P
    v = (D * y2 + 1) % P
    x2 = u * pow(v, P - 2, P) % P
    x = pow(x2, (P + 3) // 8, P)
    if (v * x * x - u) % P != 0:
        x = x * I_SQRT % P
    if (v * x * x - u) % P != 0:
        return None
    x %= P
    if x == 0:
        if sign:
            return None
        return (0, y)
    if (x & 1) != sign:
        x = P - x
    return (x, y)


def point_add(p1, p2):
    x1, y1 = p1
    x2, y2 = p2
    t = D * x1 * x2 * y1 * y2 % P
    z1 = pow((1 + t) % P, P - 2, P)
    z2 = pow((1 - t) % P, P - 2, P)
    x3 = (x1 * y2 + y1 * x2) % P * z1 % P
    y3 = (y1 * y2 + x1 * x2) % P * z2 % P
    return (x3, y3)


def point_mul(pt, e):
    q = (0, 1)
    p = pt
    while e:
        if e & 1:
            q = point_add(q, p)
        p = point_add(p, p)
        e >>= 1
    return q


def point_ok(b):
    key = bytes(b)
    hit = _POINT_CACHE.get(key)
    if hit is not None:
        return hit
    pt = recover_point(key)
    ok = False
    if pt is not None and not (pt[0] == 0 and pt[1] == 1):
        chk = point_mul(pt, L)
        ok = chk[0] == 0 and chk[1] == 1
    _POINT_CACHE[key] = ok
    return ok


def sig_bytes_strict(raw):
    if raw is None or len(raw) != 64:
        return False
    s = int.from_bytes(raw[32:], "little")
    if s >= L:
        return False
    return point_ok(raw[:32])


def verify(pub_b64, sig_b64, message):
    pub = b64_canonical(pub_b64, 32)
    sig = b64_canonical(sig_b64, 64)
    if pub is None or sig is None or not point_ok(pub):
        return "unusable"
    try:
        key = Ed25519PublicKey.from_public_bytes(pub)
        key.verify(sig, message)
        return True
    except Exception:
        return False


def normalize_domain(s):
    if not isinstance(s, str):
        return None
    s = s.strip().lower().rstrip(".")
    if not s or any(c in s for c in "/@: "):
        return None
    labels = s.split(".")
    if len(labels) < 2:
        return None
    for lab in labels:
        if not LABEL_RE.match(lab):
            return None
    return s


def is_https_url(s):
    if not isinstance(s, str) or not s.startswith("https://"):
        return False
    if any(c.isspace() for c in s):
        return False
    rest = s[8:]
    if not rest or rest.startswith("/"):
        return False
    return True


def nonempty_str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) and x for x in v)


def str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def obj_list(v):
    return isinstance(v, list) and all(isinstance(x, dict) for x in v)


def without(d, *keys):
    return {k: v for k, v in d.items() if k not in keys}


def numbers_and_keys_ok(v):
    stack = [v]
    while stack:
        x = stack.pop()
        if x is None or isinstance(x, bool) or isinstance(x, str):
            continue
        if isinstance(x, int):
            if not -MAX_SAFE <= int(x) <= MAX_SAFE:
                return False
            continue
        if isinstance(x, float):
            return False
        if isinstance(x, list):
            stack.extend(x)
            continue
        if isinstance(x, dict):
            for k in x:
                if not isinstance(k, str) or not all(0x20 <= ord(c) <= 0x7E for c in k):
                    return False
            stack.extend(x.values())
            continue
        return False
    return True


def decode_compact(bits):
    exp = bits >> 24
    mant = bits & 0x007FFFFF
    if bits & 0x00800000 or mant == 0:
        return None
    if exp >= 3:
        return mant << (8 * (exp - 3))
    return mant >> (8 * (3 - exp))


def decode_target_hex(s):
    if not is_lower_hex(s, 8):
        return None
    t = decode_compact(int(s, 16))
    if t is None or t <= 0:
        return None
    return t


def cond_actions(grant):
    out = []
    cond = grant.get("conditional") if isinstance(grant, dict) else None
    if isinstance(cond, list):
        for e in cond:
            if isinstance(e, dict) and isinstance(e.get("action"), str):
                out.append(e["action"])
    return out


def approvers_well_formed(lst, grant):
    if not isinstance(lst, list) or not (1 <= len(lst) <= 16):
        return False
    if not all(isinstance(a, dict) for a in lst):
        return False
    known = set(cond_actions(grant))
    names = []
    keys = []
    for a in lst:
        if any(k not in ("name", "public_key_ed25519_b64", "actions") for k in a):
            return False
        name = a.get("name")
        if not isinstance(name, str) or not name:
            return False
        if b64_canonical(a.get("public_key_ed25519_b64"), 32) is None:
            return False
        acts = a.get("actions")
        if not isinstance(acts, list) or not acts or len(set(acts)) != len(acts):
            return False
        for act in acts:
            if not isinstance(act, str) or not act or act not in known:
                return False
        names.append(name)
        keys.append(a["public_key_ed25519_b64"])
    if len(set(names)) != len(names) or len(set(keys)) != len(keys):
        return False
    return True


def grant_types_ok(grant):
    if "data_access" in grant and grant["data_access"] is not None:
        if not nonempty_str_list(grant["data_access"]):
            return False
    for key in ("max_hops", "expiry_height"):
        if key in grant and grant[key] is not None and not is_int(grant[key], 0):
            return False
    if "delegation" in grant and grant["delegation"] is not None:
        d = grant["delegation"]
        if not isinstance(d, dict) or set(d.keys()) != {"allowed"} or not nonempty_str_list(d.get("allowed")):
            return False
    if "conditional" in grant and grant["conditional"] is not None:
        cond = grant["conditional"]
        if not isinstance(cond, list):
            return False
        seen = set()
        for e in cond:
            if not isinstance(e, dict):
                return False
            act = e.get("action")
            if not isinstance(act, str) or not act or act in seen:
                return False
            seen.add(act)
            if "requires" in e and not isinstance(e["requires"], str):
                return False
    if "finality" in grant and grant["finality"] is not None:
        fin = grant["finality"]
        if not isinstance(fin, dict) or any(k not in ("depth", "max_target_bits") for k in fin):
            return False
        if "depth" in fin and not is_int(fin["depth"], 1):
            return False
        if "max_target_bits" in fin and decode_target_hex(fin["max_target_bits"]) is None:
            return False
    if "witnesses" in grant and grant["witnesses"] is not None:
        ws = grant["witnesses"]
        if not isinstance(ws, list):
            return False
        for w in ws:
            if not isinstance(w, dict):
                return False
            if not isinstance(w.get("name"), str) or not w["name"]:
                return False
            if b64_decode_any(w.get("public_key_ed25519_b64"), 32) is None:
                return False
    if "privacy" in grant and grant["privacy"] is not None:
        if not isinstance(grant["privacy"], str) or not grant["privacy"]:
            return False
    if "ordering" in grant and grant["ordering"] is not None:
        ordering = grant["ordering"]
        if not isinstance(ordering, dict) or any(k != "same_height" for k in ordering):
            return False
        if "same_height" in ordering and ordering["same_height"] is not None and not isinstance(ordering["same_height"], str):
            return False
    if "approval_policy" in grant and grant["approval_policy"] is not None:
        ap = grant["approval_policy"]
        if not isinstance(ap, dict) or any(k not in ("allow_unscoped", "approvers") for k in ap):
            return False
        if "allow_unscoped" in ap and not isinstance(ap["allow_unscoped"], bool):
            return False
        if "approvers" in ap and not approvers_well_formed(ap["approvers"], grant):
            return False
    if "revocation" in grant and grant["revocation"] is not None:
        rev = grant["revocation"]
        if not isinstance(rev, dict) or any(k not in ("effective_at", "ack_window") for k in rev):
            return False
        if rev.get("effective_at") not in ("anchor", "delivery_ack"):
            return False
        if "ack_window" in rev and not is_int(rev["ack_window"], 1):
            return False
    return True


def contract_door(contract):
    if not isinstance(contract, dict):
        return False
    if contract.get("schema") != "a2a-contract-v0":
        return False
    if not is_lower_hex(contract.get("contract_id"), 32) or not is_lower_hex(contract.get("nonce"), 32):
        return False
    parties = contract.get("parties")
    if not isinstance(parties, list) or len(parties) != 2 or not all(isinstance(p, dict) for p in parties):
        return False
    roles = [p.get("role") for p in parties]
    if roles.count("principal") != 1 or roles.count("contractor") != 1:
        return False
    domains = []
    by_dom = {}
    for p in parties:
        dom = normalize_domain(p.get("domain"))
        if dom is None:
            return False
        domains.append(dom)
        if not is_https_url(p.get("key_url")):
            return False
        if b64_canonical(p.get("public_key_ed25519_b64"), 32) is None:
            return False
        by_dom[dom] = p
    if domains[0] == domains[1]:
        return False
    task = contract.get("task")
    if not isinstance(task, dict) or not isinstance(task.get("purpose"), str) or not task["purpose"]:
        return False
    if "payload_digest" in task and task["payload_digest"] is not None:
        if not is_lower_hex(task["payload_digest"], 64):
            return False
    grant = contract.get("grant")
    if not isinstance(grant, dict) or any(k not in GRANT_KEYS for k in grant):
        return False
    auth = grant.get("authorized_actions")
    proh = grant.get("prohibited_actions")
    if not nonempty_str_list(auth) or not nonempty_str_list(proh):
        return False
    if set(auth) & set(proh):
        return False
    if not grant_types_ok(grant):
        return False
    if not numbers_and_keys_ok(contract):
        return False
    est = contract.get("establishes")
    if not isinstance(est, list) or not est or not all(isinstance(s, str) for s in est):
        return False
    for s in est:
        if any(rx.search(s) for rx in EST_RES):
            return False
    dne = contract.get("does_not_establish")
    if not isinstance(dne, list) or not dne or not all(isinstance(s, str) for s in dne):
        return False
    lows = [s.lower() for s in dne]
    if not any("runtime" in s or "enforce" in s for s in lows):
        return False
    if not any("judge" in s or "liability" in s or "fault" in s for s in lows):
        return False
    if not any("deviat" in s for s in lows):
        return False
    if not any("legal" in s for s in lows):
        return False
    sigs = contract.get("signatures")
    if not isinstance(sigs, list):
        return False
    try:
        msg = b"a2a-contract-v0\n" + canonical(without(contract, "signatures"))
    except Exception:
        return False
    seen_roles = set()
    for s in sigs:
        if not isinstance(s, dict):
            return False
        dom = normalize_domain(s.get("domain"))
        if dom is None or dom not in by_dom:
            return False
        party = by_dom[dom]
        if verify(party.get("public_key_ed25519_b64"), s.get("signature"), msg) is not True:
            return False
        seen_roles.add(party.get("role"))
    if seen_roles != {"principal", "contractor"}:
        return False
    return True


def settleable_terms(contract):
    reasons = set()
    grant = contract.get("grant") if isinstance(contract, dict) else None
    if not isinstance(grant, dict):
        return reasons
    auth = grant.get("authorized_actions")
    if not isinstance(auth, list):
        reasons.add("authorized_actions_missing")
    names = []
    if isinstance(auth, list):
        names.extend(auth)
    proh = grant.get("prohibited_actions")
    if isinstance(proh, list):
        names.extend(proh)
    cond = grant.get("conditional")
    if isinstance(cond, list):
        for e in cond:
            if isinstance(e, dict):
                names.append(e.get("action"))
    if any(not isinstance(n, str) or not ACTION_RE.match(n) for n in names):
        reasons.add("grant_action_name_invalid")
    ws = grant.get("witnesses")
    if isinstance(ws, list):
        if len(ws) > 32:
            reasons.add("too_many_witnesses")
        wnames = []
        for w in ws:
            if isinstance(w, dict):
                if b64_decode_any(w.get("public_key_ed25519_b64"), 32) is None:
                    reasons.add("witness_key_invalid")
                wnames.append(w.get("name"))
        if len(wnames) != len(set(wnames)):
            reasons.add("key_conflict")
    keys = []
    parties = contract.get("parties")
    if isinstance(parties, list):
        for p in parties:
            if isinstance(p, dict):
                raw = b64_decode_any(p.get("public_key_ed25519_b64"), 32)
                if raw is not None:
                    keys.append(raw)
    if isinstance(ws, list):
        for w in ws:
            if isinstance(w, dict):
                raw = b64_decode_any(w.get("public_key_ed25519_b64"), 32)
                if raw is not None:
                    keys.append(raw)
    if len(keys) != len(set(keys)):
        reasons.add("key_conflict")
    ordering = grant.get("ordering")
    if isinstance(ordering, dict) and "same_height" in ordering:
        sh = ordering["same_height"]
        if sh is not None and sh != "conservative":
            reasons.add("tie_policy_refused")
    rev = grant.get("revocation")
    if isinstance(rev, dict) and rev.get("effective_at") not in ("anchor", "delivery_ack"):
        reasons.add("revocation_policy_not_recomputable")
    if isinstance(rev, dict) and rev.get("effective_at") == "delivery_ack" and not is_int(rev.get("ack_window"), 1):
        reasons.add("ack_window_missing")
    fin = grant.get("finality")
    depth = fin.get("depth") if isinstance(fin, dict) else None
    if not is_int(depth, 1):
        reasons.add("finality_policy_missing")
    if "expiry_height" in grant and grant["expiry_height"] is not None and not is_int(grant["expiry_height"], 0):
        reasons.add("bad_expiry_height")
    ap = grant.get("approval_policy")
    if isinstance(ap, dict) and ap.get("allow_unscoped"):
        reasons.add("unscoped_approvals_refused")
    return reasons


def as_str_list(grant, key):
    if not isinstance(grant, dict):
        return []
    v = grant.get(key)
    if not isinstance(v, list):
        return []
    return v


def deleg_allowed(grant):
    if not isinstance(grant, dict):
        return []
    d = grant.get("delegation")
    if not isinstance(d, dict):
        return []
    a = d.get("allowed")
    return a if isinstance(a, list) else []


def cond_list(grant):
    if not isinstance(grant, dict):
        return []
    c = grant.get("conditional")
    if not isinstance(c, list):
        return []
    return [e for e in c if isinstance(e, dict)]


def requires_of(entry):
    if "requires" not in entry:
        return None
    return entry["requires"]


def grant_within(c, p):
    if not isinstance(c, dict) or not isinstance(p, dict):
        return False
    ca = as_str_list(c, "authorized_actions")
    pa = as_str_list(p, "authorized_actions")
    if any(a not in pa for a in ca):
        return False
    cp = as_str_list(c, "prohibited_actions")
    pp = as_str_list(p, "prohibited_actions")
    if any(a not in cp for a in pp):
        return False
    if any(a not in as_str_list(p, "data_access") for a in as_str_list(c, "data_access")):
        return False
    ph = json_int(p.get("max_hops")) if "max_hops" in p else None
    if ph is not None:
        ch = json_int(c.get("max_hops")) if "max_hops" in c else None
        if ch is None or ch > ph - 1:
            return False
    pa_allowed = deleg_allowed(p)
    if any(a not in pa_allowed for a in deleg_allowed(c)):
        return False
    ccond = cond_list(c)
    pcond = cond_list(p)
    ccond_by = {}
    for e in ccond:
        ccond_by[e.get("action")] = e
    c_auth = set(ca)
    for e in pcond:
        a = e.get("action")
        r = requires_of(e)
        if a in cp:
            continue
        if a not in c_auth and a not in ccond_by:
            continue
        if a not in ccond_by or requires_of(ccond_by[a]) != r:
            return False
    p_auth = set(pa)
    p_cond_actions = {e.get("action") for e in pcond}
    for e in ccond:
        a = e.get("action")
        if a not in p_auth and a not in p_cond_actions:
            return False
    pe = json_int(p.get("expiry_height")) if "expiry_height" in p else None
    if pe is not None:
        ce = json_int(c.get("expiry_height")) if "expiry_height" in c else None
        if ce is None or ce > pe:
            return False
    prev = p.get("revocation")
    if isinstance(prev, dict):
        crev = c.get("revocation")
        if not isinstance(crev, dict) or "effective_at" not in crev:
            return False
        m = prev.get("effective_at")
        cm = crev.get("effective_at")
        if m == "anchor":
            if cm != "anchor":
                return False
        elif m == "delivery_ack":
            if cm == "anchor":
                pass
            elif cm == "delivery_ack":
                if "ack_window" in prev and json_int(prev.get("ack_window")) is not None:
                    w = json_int(prev.get("ack_window"))
                    cw = json_int(crev.get("ack_window")) if "ack_window" in crev else None
                    if cw is None or cw > w:
                        return False
            else:
                return False
        else:
            return False
    pf = p.get("finality")
    if isinstance(pf, dict):
        cf = c.get("finality")
        if not isinstance(cf, dict):
            return False
        if "depth" in pf and json_int(pf.get("depth")) is not None:
            d = json_int(pf.get("depth"))
            cd = json_int(cf.get("depth")) if "depth" in cf else None
            if cd is None or cd < d:
                return False
        if "max_target_bits" in pf and decode_target_hex(pf.get("max_target_bits")) is not None:
            pt = decode_target_hex(pf.get("max_target_bits"))
            if "max_target_bits" not in cf:
                return False
            ct = decode_target_hex(cf.get("max_target_bits"))
            if ct is None or ct > pt:
                return False
    pws = p.get("witnesses")
    pkeys = []
    if isinstance(pws, list):
        for w in pws:
            if isinstance(w, dict) and isinstance(w.get("public_key_ed25519_b64"), str):
                pkeys.append(w["public_key_ed25519_b64"])
    if pkeys:
        ckeys = []
        cws = c.get("witnesses")
        if isinstance(cws, list):
            for w in cws:
                if isinstance(w, dict) and isinstance(w.get("public_key_ed25519_b64"), str):
                    ckeys.append(w["public_key_ed25519_b64"])
        if not ckeys or any(k not in ckeys for k in pkeys):
            return False
    for key in ("privacy", "ordering"):
        if key in p and p[key] is not None:
            if key not in c or c[key] is None:
                return False
            if canonical(p[key]) != canonical(c[key]):
                return False
    def unscoped(g):
        ap = g.get("approval_policy")
        return isinstance(ap, dict) and ap.get("allow_unscoped") is True
    if unscoped(c) and not unscoped(p):
        return False
    def approver_set(g):
        ap = g.get("approval_policy")
        if not isinstance(ap, dict) or "approvers" not in ap or not isinstance(ap.get("approvers"), list):
            return set()
        return {canonical(e) for e in ap["approvers"]}
    if approver_set(c) != approver_set(p):
        return False
    return True


def strict_terms(contract, parent, parent_supplied):
    reasons = set()
    sigs = contract.get("signatures") if isinstance(contract, dict) else None
    if isinstance(sigs, list):
        for s in sigs:
            if not isinstance(s, dict):
                continue
            raw = b64_decode_any(s.get("signature"), 64)
            if raw is not None and not sig_bytes_strict(raw):
                reasons.add("contract_signature_not_strict")
                break
    if isinstance(contract, dict) and "bond" in contract and contract["bond"] is not None:
        bond = contract["bond"]
        amt = bond.get("amount") if isinstance(bond, dict) else None
        if not (isinstance(bond, dict) and is_int(amt, 1, MAX_SAFE)):
            reasons.add("bond_malformed")
    if isinstance(contract, dict) and "parent_contract" in contract and contract["parent_contract"] is not None:
        if not parent_supplied:
            reasons.add("parent_not_supplied")
        else:
            pc = contract.get("parent_contract")
            ok = (
                isinstance(parent, dict)
                and isinstance(pc, dict)
                and contract_door(parent)
                and contract_door(contract)
                and "contract_id" in pc
                and "contract_id" in parent
                and pc.get("contract_id") == parent.get("contract_id")
                and grant_within(contract.get("grant"), parent.get("grant"))
            )
            if not ok:
                reasons.add("parent_narrowing_failed")
    return reasons


def out_of_scope(contract):
    if not isinstance(contract, dict):
        return False
    req = contract.get("requirements")
    if isinstance(req, dict):
        if "spine" in req or "convergence" in req:
            return True
        if "admission" in req and req["admission"] is not None:
            return True
    grant = contract.get("grant")
    if isinstance(grant, dict):
        if "limits" in grant and grant["limits"] is not None:
            return True
        ap = grant.get("approval_policy")
        if isinstance(ap, dict) and "approvers" in ap and approvers_well_formed(ap.get("approvers"), grant):
            return True
    return False


def header_hash(raw):
    return hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1].hex()


def parse_header_hex(h):
    if not isinstance(h, str):
        return None
    body = h[:-1] if h.endswith("\n") and len(h) == 161 else h
    if not is_lower_hex(body, 160):
        return None
    if h != body and not (len(h) == 161 and h.endswith("\n")):
        return None
    return bytes.fromhex(body)


class ViewInfo:
    def __init__(self):
        self.headers = {}
        self.tip = None
        self.lower_height = None
        self.lower_hash = None
        self.floor = None


def check_view(contract, view):
    reasons = set()
    info = ViewInfo()
    ok = True
    grant = contract.get("grant") if isinstance(contract, dict) else None
    fin = grant.get("finality") if isinstance(grant, dict) else None
    floor_s = fin.get("max_target_bits") if isinstance(fin, dict) else None
    floor = decode_target_hex(floor_s) if isinstance(floor_s, str) else None
    if floor is None:
        ok = False
    else:
        info.floor = floor
    lb = contract.get("lower_bound") if isinstance(contract, dict) else None
    if not isinstance(lb, dict) or json_int(lb.get("height")) is None or not is_lower_hex(lb.get("hash"), 64):
        ok = False
    else:
        info.lower_height = json_int(lb.get("height"))
        info.lower_hash = lb.get("hash")
    headers = view.get("headers") if isinstance(view, dict) else None
    if not isinstance(headers, list) or not headers:
        ok = False
    parsed = []
    if isinstance(headers, list):
        prev_h = None
        prev_hash = None
        for h in headers:
            if not isinstance(h, dict) or json_int(h.get("height")) is None or json_int(h.get("height")) < 0:
                ok = False
                parsed = None
                break
            raw = parse_header_hex(h.get("hex"))
            if raw is None:
                ok = False
                parsed = None
                break
            height = json_int(h.get("height"))
            if prev_h is not None and height != prev_h + 1:
                ok = False
            hh = header_hash(raw)
            if prev_hash is not None:
                prev_field = raw[4:36][::-1].hex()
                if prev_field != prev_hash:
                    ok = False
            nbits = int.from_bytes(raw[72:76], "little")
            target = decode_compact(nbits)
            if target is None or floor is None or target > floor:
                ok = False
            elif int(hh, 16) > target:
                ok = False
            parsed.append((height, hh, raw[36:68]))
            prev_h = height
            prev_hash = hh
        if parsed is not None and ok:
            found = False
            for height, hh, merkle in parsed:
                info.headers[height] = {"hash": hh, "merkle": merkle}
            if parsed:
                info.tip = parsed[-1][0]
            if info.lower_height is not None:
                hdr = info.headers.get(info.lower_height)
                if hdr is None or hdr["hash"] != info.lower_hash:
                    ok = False
                else:
                    found = True
            if not found:
                ok = False
    if not ok:
        reasons.add("chain_view_rejected")
        info = None
    elif parsed is not None and len(parsed) > 200000:
        reasons.add("input_too_large")
        info = None
        ok = False
    if isinstance(view, dict) and isinstance(view.get("headers"), list):
        strict_ok = is_strict(view)
        for h in view["headers"]:
            if not isinstance(h, dict) or json_int(h.get("height")) is None or not is_lower_hex(h.get("hex"), 160):
                strict_ok = False
                break
        if not strict_ok:
            reasons.add("view_not_strict")
    return ok, reasons, info


class Rec:
    def __init__(self, raw, sha, sign_bytes):
        self.raw = raw
        self.sha = sha
        self.sign_bytes = sign_bytes
        self.schema = raw.get("schema")


def party_key(contract, role):
    parties = contract.get("parties") if isinstance(contract, dict) else None
    if not isinstance(parties, list):
        return None
    for p in parties:
        if isinstance(p, dict) and p.get("role") == role:
            return p.get("public_key_ed25519_b64")
    return None


def witness_key(contract, name):
    if not isinstance(name, str):
        return None
    grant = contract.get("grant") if isinstance(contract, dict) else None
    if not isinstance(grant, dict):
        return None
    ws = grant.get("witnesses")
    if not isinstance(ws, list):
        return None
    for w in ws:
        if isinstance(w, dict) and w.get("name") == name:
            return w.get("public_key_ed25519_b64")
    return None


def all_keys(contract):
    keys = []
    for role in ("principal", "contractor"):
        k = party_key(contract, role)
        if isinstance(k, str):
            keys.append(k)
    grant = contract.get("grant") if isinstance(contract, dict) else None
    ws = grant.get("witnesses") if isinstance(grant, dict) else None
    if isinstance(ws, list):
        for w in ws:
            if isinstance(w, dict) and isinstance(w.get("public_key_ed25519_b64"), str):
                keys.append(w["public_key_ed25519_b64"])
    return keys


def matching_key(schema, entry, contract):
    if not isinstance(entry, dict):
        return None
    role = entry.get("role")
    if schema == "a2a-execution-v0" and role == "contractor":
        return party_key(contract, "contractor")
    if schema == "a2a-execution-v0" and role == "witness":
        return witness_key(contract, entry.get("witness_name"))
    if schema == "a2a-revocation-v0" and role == "principal":
        return party_key(contract, "principal")
    if schema == "a2a-revocation-ack-v0" and role == "contractor":
        return party_key(contract, "contractor")
    return None


def classify_signing(rec, contract):
    sigs = rec.raw.get("signatures")
    if not isinstance(sigs, list) or not sigs:
        return "none"
    msg = rec.sign_bytes
    lax = False
    for entry in sigs:
        key = matching_key(rec.schema, entry, contract)
        if key is None:
            continue
        result = verify(key, entry.get("sig_b64"), msg)
        if result is True:
            raw = b64_canonical(entry.get("sig_b64"), 64)
            if raw is not None and sig_bytes_strict(raw) and is_strict(entry):
                return "strict"
            if raw is None or not sig_bytes_strict(raw):
                lax = True
    if not lax:
        for entry in sigs:
            if not isinstance(entry, dict):
                continue
            sig = entry.get("sig_b64")
            raw = b64_canonical(sig, 64)
            if raw is not None and sig_bytes_strict(raw):
                continue
            for key in all_keys(contract):
                if verify(key, sig, msg) is True:
                    lax = True
                    break
            if lax:
                break
    return "lax" if lax else "none"


def body_not_strict(raw):
    body = without(raw, "signatures", "anchor")
    if not is_strict(body):
        return True
    if "nenrin_ref" in body and body["nenrin_ref"] is not None and not is_lower_hex(body["nenrin_ref"], 64):
        return True
    cref = body.get("contract_ref")
    if isinstance(cref, dict):
        for fld in ("contract_sha256", "payload_digest"):
            if fld in cref and not is_lower_hex(cref[fld], 64):
                return True
    if raw.get("schema") == "a2a-execution-v0":
        if "performed_actions" in body and not str_list(body["performed_actions"]):
            return True
        if "delegated_to" in body and not str_list(body["delegated_to"]):
            return True
        if "approvals" in body and not obj_list(body["approvals"]):
            return True
        approvals = body.get("approvals")
        if isinstance(approvals, list):
            for ap in approvals:
                if not isinstance(ap, dict):
                    continue
                for fld in ("sig_b64", "signature"):
                    if fld in ap:
                        raw_sig = b64_decode_any(ap[fld], 64)
                        if raw_sig is not None and not sig_bytes_strict(raw_sig):
                            return True
    return False


def anchor_not_strict(raw):
    if "anchor" not in raw:
        return False
    anc = raw.get("anchor")
    if not is_strict(anc):
        return True
    if not isinstance(anc, dict):
        return True
    if "block_hash" in anc and not is_lower_hex(anc["block_hash"], 64):
        return True
    proof = anc.get("proof")
    if isinstance(proof, list):
        for op in proof:
            if isinstance(op, dict) and "hex" in op and not hex_pairs(op["hex"]):
                return True
    return False


def payload_of(contract):
    task = contract.get("task") if isinstance(contract, dict) else None
    if isinstance(task, dict) and "payload_digest" in task:
        return task["payload_digest"]
    return None


def classify_binding(ref, cid, pdg, csha):
    if "contract_sha256" not in ref or ref.get("contract_sha256") is None:
        if ref.get("contract_id") == cid:
            return "unbound"
        return "drop"
    sha = ref.get("contract_sha256")
    if not is_lower_hex(sha, 64):
        return "inconsistent"
    if sha != csha:
        return "foreign"
    if ref.get("contract_id") != cid:
        return "inconsistent"
    if pdg is not None and ref.get("payload_digest") != pdg:
        return "inconsistent"
    return "bound"


def bind_records(contract, events, csha):
    cid = contract.get("contract_id") if isinstance(contract, dict) else None
    pdg = payload_of(contract)
    seen = set()
    bound = []
    disps = {}
    if not isinstance(events, list):
        return bound, disps
    for ev in events:
        if not isinstance(ev, dict) or ev.get("schema") not in CTX:
            continue
        try:
            sha = sha256_hex(canonical(ev))
            body = without(ev, "signatures", "anchor")
            sign_bytes = CTX[ev["schema"]] + canonical(body)
        except Exception:
            continue
        if sha in seen:
            continue
        seen.add(sha)
        ref = ev.get("contract_ref")
        if not isinstance(ref, dict):
            ref = {}
        cls = classify_binding(ref, cid, pdg, csha)
        if cls == "drop":
            continue
        if cls == "bound":
            bound.append(Rec(ev, sha, sign_bytes))
        else:
            disps[sha] = cls
    return bound, disps


def body_digest(raw):
    return hashlib.sha256(canonical(without(raw, "anchor"))).digest()


def proof_reaches(raw, merkle):
    anc = raw.get("anchor")
    if not isinstance(anc, dict):
        return False
    proof = anc.get("proof")
    if not isinstance(proof, list) or not proof or len(proof) > 512:
        return False
    current = body_digest(raw)
    for op in proof:
        if not isinstance(op, dict):
            return False
        name = op.get("op")
        if name == "sha256":
            current = hashlib.sha256(current).digest()
        elif name == "hexlify":
            current = current.hex().encode("ascii")
        elif name in ("append", "prepend"):
            hx = op.get("hex")
            if not hex_pairs(hx):
                return False
            extra = bytes.fromhex(hx)
            if len(extra) > 4096:
                return False
            current = current + extra if name == "append" else extra + current
        else:
            return False
        if len(current) > 65536:
            return False
    return current == merkle


class BatchParser:
    def __init__(self, s):
        self.s = s
        self.n = len(s)
        self.i = 0
        self.depth = 0

    def skip(self):
        while self.i < self.n and self.s[self.i] in " \t\r\n":
            self.i += 1

    def parse(self):
        self.skip()
        v = self.val()
        self.skip()
        if self.i != self.n:
            raise ValueError("trailing")
        return v

    def val(self):
        self.skip()
        if self.i >= self.n:
            raise ValueError("eof")
        c = self.s[self.i]
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c == '"':
            return self.string()
        if c == "t":
            self.lit("true")
            return True
        if c == "f":
            self.lit("false")
            return False
        if c == "n":
            self.lit("null")
            return None
        if c == "N":
            self.lit("NaN")
            return float("nan")
        if c == "I":
            self.lit("Infinity")
            return float("inf")
        if c == "-" and self.s.startswith("-Infinity", self.i):
            self.i += 9
            return float("-inf")
        if c == "-" or c.isdigit():
            return self.number()
        raise ValueError("value")

    def lit(self, word):
        if not self.s.startswith(word, self.i):
            raise ValueError("lit")
        self.i += len(word)

    def obj(self):
        self.depth += 1
        if self.depth > 512:
            raise ValueError("depth")
        self.i += 1
        d = {}
        self.skip()
        if self.i < self.n and self.s[self.i] == "}":
            self.i += 1
            self.depth -= 1
            return d
        while True:
            self.skip()
            key = str(self.string())
            self.skip()
            if self.i >= self.n or self.s[self.i] != ":":
                raise ValueError("colon")
            self.i += 1
            val = self.val()
            if key in d:
                raise ValueError("dup")
            d[key] = val
            self.skip()
            if self.i < self.n and self.s[self.i] == ",":
                self.i += 1
                continue
            if self.i < self.n and self.s[self.i] == "}":
                self.i += 1
                self.depth -= 1
                return d
            raise ValueError("obj")

    def arr(self):
        self.depth += 1
        if self.depth > 512:
            raise ValueError("depth")
        self.i += 1
        arr = []
        self.skip()
        if self.i < self.n and self.s[self.i] == "]":
            self.i += 1
            self.depth -= 1
            return arr
        while True:
            arr.append(self.val())
            self.skip()
            if self.i < self.n and self.s[self.i] == ",":
                self.i += 1
                continue
            if self.i < self.n and self.s[self.i] == "]":
                self.i += 1
                self.depth -= 1
                return arr
            raise ValueError("arr")

    def string(self):
        if self.i >= self.n or self.s[self.i] != '"':
            raise ValueError("str")
        self.i += 1
        start_char = self.i
        escaped = False
        out = []
        while self.i < self.n:
            c = self.s[self.i]
            if c == '"':
                self.i += 1
                start_byte = len(self.s[:start_char].encode("utf-8"))
                return SpanStr("".join(out), start_byte, escaped)
            if c == "\\":
                escaped = True
                self.i += 1
                if self.i >= self.n:
                    raise ValueError("esc")
                e = self.s[self.i]
                mapping = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
                if e in mapping:
                    out.append(mapping[e])
                    self.i += 1
                elif e == "u":
                    hexpart = self.s[self.i + 1 : self.i + 5]
                    if len(hexpart) != 4 or any(ch not in "0123456789abcdefABCDEF" for ch in hexpart):
                        raise ValueError("u")
                    out.append(chr(int(hexpart, 16)))
                    self.i += 5
                else:
                    raise ValueError("esc")
            elif ord(c) < 0x20:
                raise ValueError("ctrl")
            else:
                out.append(c)
                self.i += 1
        raise ValueError("unterminated")

    def number(self):
        start = self.i
        if self.s[self.i] == "-":
            self.i += 1
        if self.i >= self.n or not self.s[self.i].isdigit():
            raise ValueError("num")
        if self.s[self.i] == "0":
            self.i += 1
        else:
            while self.i < self.n and self.s[self.i].isdigit():
                self.i += 1
        is_float = False
        if self.i < self.n and self.s[self.i] == ".":
            is_float = True
            self.i += 1
            if self.i >= self.n or not self.s[self.i].isdigit():
                raise ValueError("frac")
            while self.i < self.n and self.s[self.i].isdigit():
                self.i += 1
        if self.i < self.n and self.s[self.i] in "eE":
            is_float = True
            self.i += 1
            if self.i < self.n and self.s[self.i] in "+-":
                self.i += 1
            if self.i >= self.n or not self.s[self.i].isdigit():
                raise ValueError("exp")
            while self.i < self.n and self.s[self.i].isdigit():
                self.i += 1
        token = self.s[start : self.i]
        if is_float:
            return float(token)
        digits = token[1:] if token.startswith("-") else token
        if len(digits) > 4300:
            raise ValueError("long")
        return int(token)


def batch_leg_ok(raw):
    anc = raw.get("anchor")
    if not isinstance(anc, dict):
        return False
    ops = anc.get("proof")
    if not isinstance(ops, list):
        return False
    hexlifies = [i for i, op in enumerate(ops) if isinstance(op, dict) and op.get("op") == "hexlify"]
    if not hexlifies:
        return True
    if hexlifies != [0]:
        return False
    digest = body_digest(raw)
    digest_hex = digest.hex()
    batch = bytearray(digest_hex.encode("ascii"))
    pre_len = 0
    found = False
    for op in ops[1:]:
        if not isinstance(op, dict):
            return False
        name = op.get("op")
        if name == "sha256":
            found = True
            break
        if name not in ("append", "prepend"):
            return False
        hx = op.get("hex")
        if not hex_pairs(hx):
            return False
        extra = bytes.fromhex(hx)
        if len(extra) > 4096:
            return False
        if name == "prepend":
            batch = bytearray(extra) + batch
            pre_len += len(extra)
        else:
            batch.extend(extra)
    if not found:
        return False
    try:
        text = bytes(batch).decode("utf-8")
        obj = BatchParser(text).parse()
    except Exception:
        return False
    if not isinstance(obj, dict) or obj.get("schema") not in BATCH_SCHEMAS:
        return False
    records = obj.get("records")
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        return False
    if "count" in obj and obj.get("count") != len(records):
        return False
    matches = [i for i, r in enumerate(records) if r.get("sha") == digest_hex]
    if len(matches) != 1:
        return False
    idx = matches[0]
    entry = records[idx]
    if obj.get("schema") == "nenrin-agreement-batch-v1":
        kind = {"a2a-execution-v0": "execution"}.get(raw.get("schema"))
        if kind is None:
            return False
        if entry.get("kind") != kind:
            return False
        if "schema" in entry and entry.get("schema") != raw.get("schema"):
            return False
    sha = entry.get("sha")
    if not isinstance(sha, SpanStr) or sha.escaped or sha.start_byte != pre_len:
        return False
    return True


def anchors_validly(rec, viewinfo):
    if viewinfo is None:
        return False
    anc = rec.raw.get("anchor")
    if not isinstance(anc, dict):
        return False
    h = json_int(anc.get("height"))
    if h is None or h < 0:
        return False
    bh = anc.get("block_hash")
    if not is_lower_hex(bh, 64):
        return False
    hdr = viewinfo.headers.get(h)
    if hdr is None or hdr["hash"] != bh:
        return False
    if not proof_reaches(rec.raw, hdr["merkle"]):
        return False
    if not batch_leg_ok(rec.raw):
        return False
    return True


def triage(bound, contract, viewinfo):
    reasons = set()
    disps = {}
    meta = []
    grant = contract.get("grant") if isinstance(contract, dict) else None
    rev_obj = isinstance(grant, dict) and isinstance(grant.get("revocation"), dict)
    groups = {}
    for rec in bound:
        sign = classify_signing(rec, contract)
        bbad = body_not_strict(rec.raw)
        abad = anchor_not_strict(rec.raw)
        meta.append((rec, sign, bbad, abad))
        groups.setdefault(rec.sign_bytes, []).append(rec)
    info = {rec.sha: (sign, bbad, abad) for rec, sign, bbad, abad in meta}

    def table_kept(rec):
        sign, bbad, abad = info[rec.sha]
        if sign != "strict" or bbad or abad:
            return False
        if rec.schema == "a2a-revocation-v0" and not rev_obj:
            return False
        return True

    kept = []
    for rec, sign, bbad, abad in meta:
        if sign != "strict" and bbad:
            disps[rec.sha] = "record_not_strict"
            continue
        if sign != "strict" and sign == "lax":
            disps[rec.sha] = "signature_not_strict"
            continue
        if sign != "strict":
            disps[rec.sha] = "rejected"
            continue
        if bbad:
            disps[rec.sha] = "record_not_strict"
            reasons.add("record_not_strict")
            continue
        if abad:
            others = [
                other
                for other in groups[rec.sign_bytes]
                if other.sha != rec.sha and table_kept(other) and anchors_validly(other, viewinfo)
            ]
            disps[rec.sha] = "anchor_not_strict"
            if not others:
                reasons.add("anchor_not_strict")
            continue
        if rec.schema == "a2a-revocation-v0" and not rev_obj:
            disps[rec.sha] = "revocation_not_provided_for"
            continue
        kept.append(rec)
    return kept, disps, reasons


def collapse(kept, viewinfo):
    groups = {}
    order = []
    for rec in kept:
        if rec.sign_bytes not in groups:
            order.append(rec.sign_bytes)
            groups[rec.sign_bytes] = []
        groups[rec.sign_bytes].append(rec)
    out = []
    disps = {}
    for key in order:
        group = groups[key]
        shas = {r.sha for r in group}
        if len(shas) <= 1:
            out.extend(group)
            continue
        valid = [r for r in group if anchors_validly(r, viewinfo)]
        if valid:
            def sort_key(r):
                return (json_int(r.raw["anchor"]["height"]), r.sha)
            valid.sort(key=sort_key)
            keep = valid[0]
            for r in group:
                if r.sha != keep.sha:
                    disps[r.sha] = "duplicate_dropped"
            out.append(keep)
        else:
            out.extend(group)
    return out, disps


def conformance_problem(rec):
    raw = rec.raw
    if rec.schema == "a2a-execution-v0":
        allowed = EXEC_FIELDS
    elif rec.schema == "a2a-revocation-v0":
        allowed = REV_FIELDS
    else:
        allowed = ACK_FIELDS
    if any(k not in allowed for k in raw):
        return True
    if rec.schema != "a2a-execution-v0":
        return False
    pa = raw.get("performed_actions")
    if not str_list(pa):
        return True
    if len(pa) > 256:
        return True
    if any(not ACTION_RE.match(a) for a in pa):
        return True
    if "outcomes" in raw and raw["outcomes"] is not None:
        outcomes = raw["outcomes"]
        if not isinstance(outcomes, dict):
            return True
        for k, val in outcomes.items():
            if k not in pa or val not in OUTCOMES:
                return True
    approvals = raw.get("approvals")
    if isinstance(approvals, list):
        for ap in approvals:
            if isinstance(ap, dict):
                act = ap.get("action")
                if not isinstance(act, str) or not ACTION_RE.match(act):
                    return True
    return False


def has_contractor_sig(rec, contract):
    sigs = rec.raw.get("signatures")
    key = party_key(contract, "contractor")
    if not isinstance(sigs, list) or not isinstance(key, str):
        return False
    for entry in sigs:
        if isinstance(entry, dict) and entry.get("role") == "contractor":
            if verify(key, entry.get("sig_b64"), rec.sign_bytes) is True:
                return True
    return False


def apply_conformance(kept, contract):
    disps = {}
    deviations = set()
    out = []
    for rec in kept:
        if conformance_problem(rec):
            if rec.schema == "a2a-execution-v0" and has_contractor_sig(rec, contract):
                deviations.add("nonconforming_record")
                out.append(rec)
            else:
                disps[rec.sha] = "rejected"
        else:
            out.append(rec)
    return out, disps, deviations


def ignore_revocations(kept):
    out = []
    disps = {}
    for rec in kept:
        if rec.schema == "a2a-revocation-v0" and rec.raw.get("revoked_by") != "principal":
            disps[rec.sha] = "ignored"
        else:
            out.append(rec)
    return out, disps


def anchor_disposition(rec, viewinfo):
    anc = rec.raw.get("anchor")
    height = None
    bh = None
    if isinstance(anc, dict):
        height = json_int(anc.get("height"))
        bh = anc.get("block_hash")
    if height is None or height < 0 or not is_lower_hex(bh, 64):
        return "anchor_incomplete", None
    if viewinfo.lower_height is not None and height < viewinfo.lower_height:
        return "anchor_below_lower_bound", height
    hdr = viewinfo.headers.get(height)
    if height > viewinfo.tip or hdr is None:
        return "anchor_beyond_observed_chain", height
    if bh != hdr["hash"]:
        return "orphaned", height
    if not proof_reaches(rec.raw, hdr["merkle"]):
        return "anchor_proof_invalid", height
    if not batch_leg_ok(rec.raw):
        return "anchor_batch_leg_refused", height
    return "accepted", height


def approval_fields_ok(ap, need_csha):
    if not is_int(ap.get("valid_until_height"), 0):
        return False
    if not is_lower_hex(ap.get("nonce"), 32):
        return False
    if not isinstance(ap.get("single_use"), bool):
        return False
    if need_csha and not is_lower_hex(ap.get("contract_sha256"), 64):
        return False
    return True


def field_or_null(ap, key):
    return ap[key] if key in ap else None


def classify_approval(ap, pk, contract, csha):
    if not isinstance(ap, dict) or not isinstance(pk, str):
        return "forged"
    sig = ap.get("sig_b64")
    if approval_fields_ok(ap, True):
        msg = b"a2a-approval-v2\n" + canonical(
            {
                "contract_sha256": ap["contract_sha256"],
                "action": field_or_null(ap, "action"),
                "valid_until_height": ap["valid_until_height"],
                "nonce": ap["nonce"],
                "single_use": ap["single_use"],
            }
        )
        if verify(pk, sig, msg) is True:
            return "counted" if ap["contract_sha256"] == csha else "other_terms"
    if approval_fields_ok(ap, False):
        msg = b"a2a-approval-v1\n" + canonical(
            {
                "contract_id": contract.get("contract_id"),
                "payload_digest": payload_of(contract),
                "action": field_or_null(ap, "action"),
                "valid_until_height": ap["valid_until_height"],
                "nonce": ap["nonce"],
                "single_use": ap["single_use"],
            }
        )
        if verify(pk, sig, msg) is True:
            return "label_bound"
    msg = b"a2a-approval-v0\n" + canonical(
        {
            "contract_id": contract.get("contract_id") if isinstance(contract, dict) and "contract_id" in contract else None,
            "payload_digest": payload_of(contract),
            "action": field_or_null(ap, "action"),
        }
    )
    if verify(pk, sig, msg) is True:
        return "label_bound"
    return "forged"


def walk_grant(accepted, contract, csha, surviving_sha):
    deviations = set()
    grant = contract.get("grant") if isinstance(contract, dict) else {}
    if not isinstance(grant, dict):
        grant = {}
    pk = party_key(contract, "principal")
    prohibited = set(as_str_list(grant, "prohibited_actions"))
    authorized = set(as_str_list(grant, "authorized_actions"))
    conditional = {}
    for e in cond_list(grant):
        if isinstance(e.get("action"), str):
            conditional[e["action"]] = e
    allowed_deleg = set(deleg_allowed(grant))
    expiry = json_int(grant.get("expiry_height")) if "expiry_height" in grant and grant.get("expiry_height") is not None else None
    rev_policy = grant.get("revocation") if isinstance(grant.get("revocation"), dict) else None
    counted = []
    forged = False
    for rec in accepted:
        if rec.schema != "a2a-execution-v0":
            continue
        approvals = rec.raw.get("approvals")
        if not isinstance(approvals, list):
            continue
        for ap in approvals:
            cls = classify_approval(ap, pk, contract, csha)
            if cls == "forged":
                forged = True
            elif cls == "counted":
                counted.append(
                    {
                        "action": ap.get("action"),
                        "height": rec.height,
                        "rec_sha": rec.sha,
                        "valid_until": json_int(ap.get("valid_until_height")),
                        "nonce": ap.get("nonce"),
                        "single_use": ap.get("single_use") is True,
                    }
                )
    if forged:
        deviations.add("forged_approval")
    revocations = [r for r in accepted if r.schema == "a2a-revocation-v0"]
    acks = [r for r in accepted if r.schema == "a2a-revocation-ack-v0"]
    eff = []
    if isinstance(rev_policy, dict):
        mode = rev_policy.get("effective_at")
        window = json_int(rev_policy.get("ack_window"))
        for rev in revocations:
            h = rev.height
            if mode == "anchor":
                e = h
            else:
                names = {sha256_hex(canonical(without(rev.raw, "anchor")))}
                names |= set(surviving_sha.get(rev.sign_bytes, []))
                cands = []
                if window is not None:
                    cands.append(h + window)
                for ack in acks:
                    if ack.raw.get("revocation_sha256") in names:
                        cands.append(ack.height)
                e = min(cands) if cands else h
            eff.append(e)
    consumed = set()
    for rec in accepted:
        if rec.schema != "a2a-execution-v0":
            continue
        h = rec.height
        revoked = any(e <= h for e in eff)
        actions = rec.raw.get("performed_actions")
        if not isinstance(actions, list):
            actions = []
        if revoked:
            if any(isinstance(a, str) for a in actions):
                deviations.add("revoked")
            continue
        for a in actions:
            if not isinstance(a, str):
                continue
            if expiry is not None and h > expiry:
                deviations.add("after_expiry")
            if a in prohibited:
                deviations.add("prohibited")
                continue
            if a in conditional:
                used = None
                for ap in counted:
                    if ap["action"] != a:
                        continue
                    if ap["rec_sha"] != rec.sha and not (ap["height"] < h):
                        continue
                    if ap["valid_until"] is None or h > ap["valid_until"]:
                        continue
                    if ap["single_use"] and ap["nonce"] in consumed:
                        continue
                    used = ap
                    break
                if used is None:
                    deviations.add("conditional")
                elif used["single_use"]:
                    consumed.add(used["nonce"])
                continue
            if a not in authorized:
                deviations.add("unauthorized")
        delegated = rec.raw.get("delegated_to")
        if isinstance(delegated, list):
            for d in delegated:
                if isinstance(d, str) and d not in allowed_deleg:
                    deviations.add("delegation")
    return deviations


def nenrin_checks(execs, nenrin, csha):
    reasons = set()
    deviations = set()
    if not isinstance(nenrin, list) or not nenrin:
        return reasons, deviations
    index = {}
    bad = set()
    for w in nenrin:
        if not isinstance(w, dict):
            continue
        try:
            sha = sha256_hex(canonical(w))
        except Exception:
            continue
        if not is_strict(w):
            bad.add(sha)
        else:
            index[sha] = w
    seen = set()
    for rec in execs:
        if rec.sha in seen:
            continue
        seen.add(rec.sha)
        ref = rec.raw.get("nenrin_ref")
        if ref in bad:
            reasons.add("walk_not_strict")
        walk = index.get(ref)
        if walk is None:
            continue
        ctx = walk.get("context")
        if isinstance(ctx, dict) and "contract_sha256" in ctx and ctx["contract_sha256"] is not None and ctx["contract_sha256"] != csha:
            deviations.add("evidence_names_other_contract")
    return reasons, deviations


def evidence_missing(accepted, contract):
    req = contract.get("requirements") if isinstance(contract, dict) else None
    if not isinstance(req, dict) or req.get("evidence") != "nenrin_required":
        return False
    for rec in accepted:
        if rec.schema == "a2a-execution-v0" and not is_lower_hex(rec.raw.get("nenrin_ref"), 64):
            return True
    return False


def bond_outcome(contract, verdict, status):
    if not isinstance(contract, dict) or "bond" not in contract or contract.get("bond") is None:
        return "n/a"
    bond = contract.get("bond")
    amt = bond.get("amount") if isinstance(bond, dict) else None
    n = json_int(amt)
    well = isinstance(bond, dict) and n is not None and 1 <= n <= MAX_SAFE
    if well:
        if verdict == "underspecified":
            return "undetermined"
        if status == "provisional":
            return "pending_finality"
        if verdict == "deviation":
            return "forfeited"
        return "held"
    if isinstance(bond, dict) and "amount" in bond and bool(bond.get("amount")):
        return "undetermined"
    return "n/a"


def core_result(csha, verdict, status, bond, deviations, reasons, event_set, dispositions):
    return {
        "contract_sha256": csha,
        "verdict": verdict,
        "status": status,
        "bond_outcome": bond,
        "deviation_codes": sorted(deviations) if verdict == "deviation" else [],
        "underspecified_reasons": sorted(reasons) if verdict == "underspecified" else [],
        "event_set": event_set,
        "dispositions": {k: dispositions[k] for k in sorted(dispositions)},
    }


def settle(contract, events, view, nenrin, parent, parent_supplied):
    if not isinstance(contract, dict):
        return core_result(None, "underspecified", "undetermined", "n/a", set(), {"contract_not_verified"}, [], {})
    if out_of_scope(contract):
        raise InputError("out of scope")
    csha = sha256_hex(b"a2a-contract-v0\n" + canonical(without(contract, "signatures")))
    reasons = set()
    door_ok = contract_door(contract)
    if not door_ok:
        reasons.add("contract_not_verified")
    else:
        reasons |= settleable_terms(contract)
    reasons |= strict_terms(contract, parent, parent_supplied)
    view_ok, view_reasons, viewinfo = check_view(contract, view)
    reasons |= view_reasons
    if not isinstance(events, list):
        return core_result(csha, "underspecified", "undetermined", bond_outcome(contract, "underspecified", "undetermined"), set(), reasons | {"input_not_settleable"}, [], {})
    bound, disps = bind_records(contract, events, csha)
    kept, triage_disps, triage_reasons = triage(bound, contract, viewinfo if view_ok else None)
    disps.update(triage_disps)
    reasons |= triage_reasons
    too_many = len(kept) > 10000
    if too_many:
        reasons.add("input_too_large")
    if view_ok and not too_many:
        kept, drop_disps = collapse(kept, viewinfo)
        disps.update(drop_disps)
    four_two = bool(reasons & FOUR_TWO)
    full = view_ok and door_ok and not four_two and not too_many
    event_set = []
    deviations = set()
    orphaned_heights = []
    accepted = []
    if full:
        kept, conf_disps, conf_devs = apply_conformance(kept, contract)
        disps.update(conf_disps)
        deviations |= conf_devs
        kept, ign_disps = ignore_revocations(kept)
        disps.update(ign_disps)
        execs_for_nenrin = [r for r in kept if r.schema == "a2a-execution-v0"]
        surviving = {}
        for rec in kept:
            surviving.setdefault(rec.sign_bytes, []).append(rec.sha)
        for rec in kept:
            disp, height = anchor_disposition(rec, viewinfo)
            disps[rec.sha] = disp
            rec.height = height
            if disp == "accepted":
                accepted.append(rec)
            elif disp == "orphaned":
                orphaned_heights.append(height)
            else:
                reasons.add(disp)
        accepted.sort(key=lambda r: (r.height, r.sha))
        event_set = [{"kind": KIND[r.schema], "sha256": r.sha, "height": r.height} for r in accepted]
        deviations |= walk_grant(accepted, contract, csha, surviving)
        n_reasons, n_devs = nenrin_checks(execs_for_nenrin, nenrin, csha)
        reasons |= n_reasons
        deviations |= n_devs
        if not reasons and (deviations or event_set) and evidence_missing(accepted, contract):
            deviations.add("evidence_missing")
    if reasons:
        verdict = "underspecified"
        status = "undetermined"
    else:
        if deviations:
            verdict = "deviation"
        elif not event_set:
            verdict = "nothing_to_settle"
        else:
            verdict = "within_grant"
        k = json_int(contract["grant"]["finality"]["depth"])
        horizon = viewinfo.tip - k + 1
        heights = [r.height for r in accepted] + orphaned_heights
        if not heights or all(h <= horizon for h in heights):
            status = "final"
        else:
            status = "provisional"
    return core_result(csha, verdict, status, bond_outcome(contract, verdict, status), deviations, reasons, event_set, disps)


def load_dir(path):
    p = Path(path)
    try:
        contract = parse_json((p / "contract.json").read_text(encoding="utf-8"))
        view = parse_json((p / "view.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise InputError("missing input")
    except UnicodeError:
        raise InputError("invalid utf-8")
    events = []
    evdir = p / "events"
    if evdir.is_dir():
        for f in sorted(evdir.iterdir(), key=lambda x: x.name):
            if f.is_file():
                try:
                    events.append(parse_json(f.read_text(encoding="utf-8")))
                except UnicodeError:
                    raise InputError("invalid utf-8")
    nenrin = None
    ndir = p / "nenrin"
    if ndir.is_dir():
        nenrin = []
        for f in sorted(ndir.iterdir(), key=lambda x: x.name):
            if f.is_file():
                try:
                    nenrin.append(parse_json(f.read_text(encoding="utf-8")))
                except UnicodeError:
                    raise InputError("invalid utf-8")
    parent = None
    parent_supplied = False
    pp = p / "parent.json"
    if pp.is_file():
        try:
            parent = parse_json(pp.read_text(encoding="utf-8"))
        except UnicodeError:
            raise InputError("invalid utf-8")
        parent_supplied = True
    return contract, events, view, nenrin, parent, parent_supplied


def main():
    if len(sys.argv) != 2:
        fail("usage")
    try:
        args = load_dir(sys.argv[1])
        result = settle(*args)
    except InputError as e:
        fail(str(e))
    emit(result, 0)


if __name__ == "__main__":
    main()
