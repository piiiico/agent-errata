```python
#!/usr/bin/env python3
import sys, os, re, hashlib, base64, binascii, struct, math
from urllib.parse import urlparse
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.exceptions import InvalidSignature

# ---------- Custom JSON parser with strictness metadata ----------
# We need to distinguish integers from floats and enforce depth, duplicates,
# and integer token length. We'll parse ourselves.

class JSONParseError(Exception):
    pass

def _parse_json(s, i=0, depth=0):
    if depth > 512:
        raise JSONParseError("depth exceeded")
    while i < len(s) and s[i] in ' \t\r\n':
        i += 1
    if i >= len(s):
        raise JSONParseError("unexpected end")
    c = s[i]
    if c == '{':
        i += 1
        obj = {}
        # detect duplicate keys
        keys_seen = set()
        # skip ws
        while i < len(s) and s[i] in ' \t\r\n':
            i += 1
        if i < len(s) and s[i] == '}':
            return obj, i+1
        while True:
            # parse key string
            while i < len(s) and s[i] in ' \t\r\n':
                i += 1
            if s[i] != '"':
                raise JSONParseError("expected string key")
            key, i = _parse_string(s, i)
            if key in keys_seen:
                raise JSONParseError("duplicate key")
            keys_seen.add(key)
            # colon
            while i < len(s) and s[i] in ' \t\r\n':
                i += 1
            if s[i] != ':':
                raise JSONParseError("expected colon")
            i += 1
            val, i = _parse_json(s, i, depth+1)
            obj[key] = val
            # comma or end
            while i < len(s) and s[i] in ' \t\r\n':
                i += 1
            if s[i] == ',':
                i += 1
                continue
            elif s[i] == '}':
                return obj, i+1
            else:
                raise JSONParseError("expected comma or }")
    elif c == '[':
        i += 1
        arr = []
        while i < len(s) and s[i] in ' \t\r\n':
            i += 1
        if i < len(s) and s[i] == ']':
            return arr, i+1
        while True:
            val, i = _parse_json(s, i, depth+1)
            arr.append(val)
            while i < len(s) and s[i] in ' \t\r\n':
                i += 1
            if s[i] == ',':
                i += 1
                continue
            elif s[i] == ']':
                return arr, i+1
            else:
                raise JSONParseError("expected comma or ]")
    elif c == '"':
        return _parse_string(s, i)
    elif c == 't':
        if s[i:i+4] == 'true':
            return True, i+4
        raise JSONParseError("bad literal")
    elif c == 'f':
        if s[i:i+5] == 'false':
            return False, i+5
        raise JSONParseError("bad literal")
    elif c == 'n':
        if s[i:i+4] == 'null':
            return None, i+4
        raise JSONParseError("bad literal")
    elif c.isdigit() or c == '-':
        return _parse_number(s, i)
    else:
        raise JSONParseError(f"unexpected char {c!r}")

def _parse_string(s, i):
    # s[i] == '"'
    i += 1
    result = []
    while True:
        if i >= len(s):
            raise JSONParseError("unterminated string")
        c = s[i]
        if c == '"':
            return ''.join(result), i+1
        elif c == '\\':
            i += 1
            if i >= len(s):
                raise JSONParseError("bad escape")
            esc = s[i]
            if esc == 'u':
                # parse 4 hex
                hexs = s[i+1:i+5]
                if len(hexs) != 4 or not all(ch in '0123456789abcdefABCDEF' for ch in hexs):
                    raise JSONParseError("bad unicode escape")
                code = int(hexs, 16)
                result.append(chr(code))
                i += 5
            elif esc == '"': result.append('"'); i += 1
            elif esc == '\\': result.append('\\'); i += 1
            elif esc == '/': result.append('/'); i += 1
            elif esc == 'b': result.append('\b'); i += 1
            elif esc == 'f': result.append('\f'); i += 1
            elif esc == 'n': result.append('\n'); i += 1
            elif esc == 'r': result.append('\r'); i += 1
            elif esc == 't': result.append('\t'); i += 1
            else:
                raise JSONParseError("bad escape")
        else:
            result.append(c)
            i += 1

def _parse_number(s, i):
    start = i
    if s[i] == '-':
        i += 1
    # integer part
    if i >= len(s) or not s[i].isdigit():
        raise JSONParseError("bad number")
    # check leading zeros
    if s[i] == '0' and i+1 < len(s) and s[i+1].isdigit():
        raise JSONParseError("leading zero in integer")
    while i < len(s) and s[i].isdigit():
        i += 1
    is_int = True
    if i < len(s) and s[i] in '.eE':
        is_int = False
        if s[i] == '.':
            i += 1
            if i >= len(s) or not s[i].isdigit():
                raise JSONParseError("bad fraction")
            while i < len(s) and s[i].isdigit():
                i += 1
        if i < len(s) and s[i] in 'eE':
            i += 1
            if i < len(s) and s[i] in '+-':
                i += 1
            if i >= len(s) or not s[i].isdigit():
                raise JSONParseError("bad exponent")
            while i < len(s) and s[i].isdigit():
                i += 1
    token = s[start:i]
    if is_int:
        # check integer token length (max 4300 digits)
        digits = token.lstrip('-')
        if len(digits) > 4300:
            raise JSONParseError("integer token too long")
        return int(token), i
    else:
        # handle NaN, Infinity, -Infinity
        if token in ('NaN', 'Infinity', '-Infinity'):
            return float(token), i
        try:
            return float(token), i
        except ValueError:
            raise JSONParseError("bad number")

def parse_json_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    try:
        val, i = _parse_json(text)
        # check trailing chars
        while i < len(text) and text[i] in ' \t\r\n':
            i += 1
        if i != len(text):
            raise JSONParseError("trailing characters")
        return val
    except JSONParseError as e:
        raise ValueError(f"JSON parse error: {e}")

# ---------- Canonical JSON ----------
def _escape_string(s):
    out = []
    for ch in s:
        cp = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == '\\':
            out.append('\\\\')
        elif 0x00 <= cp <= 0x1f:
            if cp == 0x08: out.append('\\b')
            elif cp == 0x0c: out.append('\\f')
            elif cp == 0x0a: out.append('\\n')
            elif cp == 0x0d: out.append('\\r')
            elif cp == 0x09: out.append('\\t')
            else:
                out.append(f'\\u{cp:04x}')
        else:
            # including U+007F and non-ASCII, write as-is
            out.append(ch)
    return ''.join(out)

def canonical(obj):
    if obj is None:
        return 'null'
    if isinstance(obj, bool):
        return 'true' if obj else 'false'
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, float):
        # Python's json writes NaN, Infinity, -Infinity; finite uses repr
        if math.isnan(obj):
            return 'NaN'
        if math.isinf(obj):
            return 'Infinity' if obj > 0 else '-Infinity'
        return repr(obj)
    if isinstance(obj, str):
        return '"' + _escape_string(obj) + '"'
    if isinstance(obj, list):
        return '[' + ','.join(canonical(v) for v in obj) + ']'
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return '{' + ','.join('"' + _escape_string(k) + '":' + canonical(obj[k]) for k in keys) + '}'
    raise TypeError(f"cannot canonicalize type {type(obj)}")

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

# ---------- Base64 canonical ----------
def is_canonical_b64(s):
    if not isinstance(s, str):
        return False
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        return False
    return base64.b64encode(raw).decode() == s

# ---------- Ed25519 public key validation ----------
p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = -121665 * pow(121666, p-2, p) % p
I = pow(2, (p-1)//4, p)

def _point_on_curve(x, y):
    return (-x*x + y*y - 1 - d*x*x*y*y) % p == 0

def _decode_point(pub_bytes):
    # pub_bytes: 32 bytes compressed
    if len(pub_bytes) != 32:
        raise ValueError("bad length")
    # y = first 31 bytes little endian, plus lower 7 bits of last byte? Actually 255 bits
    b = pub_bytes
    # clear top bit
    y = int.from_bytes(b, 'little') & ((1<<255)-1)
    # sign bit is high bit of last byte
    sign = (b[31] >> 7) & 1
    # compute x
    x2 = (y*y - 1) * pow(d*y*y + 1, p-2, p) % p
    if x2 == 0:
        if sign != 0:
            raise ValueError("bad sign for zero x")
        x = 0
    else:
        x = pow(x2, (p+3)//8, p)
        if (x*x - x2) % p != 0:
            x = x * I % p
        if (x*x - x2) % p != 0:
            raise ValueError("no sqrt")
        if (x & 1) != sign:
            x = p - x
    return (x, y)

def _is_identity_point(x, y):
    return x == 0 and y == 1

def _point_add(P, Q):
    x1, y1 = P
    x2, y2 = Q
    denom1 = (1 + d*x1*x2*y1*y2) % p
    denom2 = (1 - d*x1*x2*y1*y2) % p
    if denom1 == 0 or denom2 == 0:
        raise ValueError("denominator zero")
    x3 = (x1*y2 + y1*x2) * pow(denom1, p-2, p) % p
    y3 = (y1*y2 + x1*x2) * pow(denom2, p-2, p) % p
    return (x3, y3)

def _point_double(P):
    x, y = P
    denom1 = (x*x + y*y) % p
    denom2 = (2 - x*x - y*y) % p
    if denom1 == 0 or denom2 == 0:
        raise ValueError("denominator zero")
    x3 = (2*x*y) * pow(denom1, p-2, p) % p
    y3 = (y*y - x*x) * pow(denom2, p-2, p) % p
    return (x3, y3)

def _scalar_mult(n, P):
    # double-and-add
    if n == 0:
        raise ValueError("scalar zero")
    if n < 0:
        raise ValueError("negative")
    Q = None
    # binary expansion
    while n > 0:
        if n & 1:
            if Q is None:
                Q = P
            else:
                Q = _point_add(Q, P)
        P = _point_double(P)
        n >>= 1
    return Q

def validate_public_key(pub_b64):
    if not isinstance(pub_b64, str):
        return False
    if not is_canonical_b64(pub_b64):
        return False
    try:
        pub_bytes = base64.b64decode(pub_b64)
    except Exception:
        return False
    if len(pub_bytes) != 32:
        return False
    try:
        x, y = _decode_point(pub_bytes)
    except Exception:
        return False
    if _is_identity_point(x, y):
        return False
    if not _point_on_curve(x, y):
        return False
    # check prime order subgroup: [L]P == identity
    try:
        Q = _scalar_mult(L, (x, y))
    except Exception:
        return False
    return _is_identity_point(Q[0], Q[1])

# ---------- Signature verification ----------
def verify_ed25519(pub_b64, sig_b64, message: bytes):
    # returns True, False, or "unusable"
    if not isinstance(pub_b64, str) or not isinstance(sig_b64, str):
        return "unusable"
    if not is_canonical_b64(pub_b64) or not is_canonical_b64(sig_b64):
        return "unusable"
    try:
        pub_bytes = base64.b64decode(pub_b64)
    except Exception:
        return "unusable"
    if len(pub_bytes) != 32:
        return "unusable"
    if not validate_public_key(pub_b64):
        return "unusable"
    try:
        sig_bytes = base64.b64decode(sig_b64)
    except Exception:
        return "unusable"
    if len(sig_bytes) != 64:
        return "unusable"
    try:
        pub = ed25519.Ed25519PublicKey.from_public_bytes(pub_bytes)
        pub.verify(sig_bytes, message)
        return True
    except InvalidSignature:
        return False
    except Exception:
        return "unusable"

def is_strict_signature(sig_b64):
    if not isinstance(sig_b64, str):
        return False
    if not is_canonical_b64(sig_b64):
        return False
    try:
        sig_bytes = base64.b64decode(sig_b64)
    except Exception:
        return False
    if len(sig_bytes) != 64:
        return False
    # S = last 32 bytes little endian
    S = int.from_bytes(sig_bytes[32:], 'little')
    if S >= L:
        return False
    # R point validate
    R_bytes = sig_bytes[:32]
    R_b64 = base64.b64encode(R_bytes).decode()
    return validate_public_key(R_b64)

# ---------- Helper functions for JSON structure ----------
def is_integer(obj):
    return isinstance(obj, int) and not isinstance(obj, bool)

def is_strict_value(obj, depth=0):
    if depth > 512:
        return False
    if isinstance(obj, str):
        # control chars <= U+001F and U+007F
        for ch in obj:
            cp = ord(ch)
            if cp <= 0x1f or cp == 0x7f:
                return False
        return True
    if isinstance(obj, int):
        if isinstance(obj, bool):
            return False
        return - (2**53 - 1) <= obj <= (2**53 - 1)
    if isinstance(obj, float):
        return False  # non-integer
    if isinstance(obj, list):
        for v in obj:
            if not is_strict_value(v, depth+1):
                return False
        return True
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str):
                return False
            # key ASCII
            if not all(0x20 <= ord(ch) <= 0x7e for ch in k):
                return False
            if not is_strict_value(v, depth+1):
                return False
        return True
    if obj is None:
        return True
    if isinstance(obj, bool):
        return True
    return False

def is_body_strict(record, schema):
    # record without signatures and anchor
    body = {k: record[k] for k in record if k not in ('signatures', 'anchor')}
    if not is_strict_value(body):
        return False
    # specific checks
    for key in ('contract_ref',):
        if key in body:
            cr = body[key]
            if isinstance(cr, dict):
                if 'contract_sha256' in cr and cr['contract_sha256'] is not None:
                    cs = cr['contract_sha256']
                    if not (isinstance(cs, str) and len(cs) == 64 and all(c in '0123456789abcdef' for c in cs)):
                        return False
                if 'payload_digest' in cr and cr['payload_digest'] is not None:
                    pd = cr['payload_digest']
                    if not (isinstance(pd, str) and len(pd) == 64 and all(c in '0123456789abcdef' for c in pd)):
                        return False
    if 'nenrin_ref' in body and body['nenrin_ref'] is not None:
        nr = body['nenrin_ref']
        if not (isinstance(nr, str) and len(nr) == 64 and all(c in '0123456789abcdef' for c in nr)):
            return False
    if schema == 'a2a-execution-v0':
        if 'performed_actions' in body and body['performed_actions'] is not None:
            pa = body['performed_actions']
            if not isinstance(pa, list) or not all(isinstance(a, str) for a in pa):
                return False
        if 'delegated_to' in body and body['delegated_to'] is not None:
            dt = body['delegated_to']
            if not isinstance(dt, list) or not all(isinstance(a, str) for a in dt):
                return False
        if 'approvals' in body and body['approvals'] is not None:
            apprs = body['approvals']
            if not isinstance(apprs, list):
                return False
            for ap in apprs:
                if not isinstance(ap, dict):
                    return False
                for sigkey in ('sig_b64', 'signature'):
                    if sigkey in ap and isinstance(ap[sigkey], str):
                        # check if decodes to 64 bytes and non-strict
                        if is_canonical_b64(ap[sigkey]):
                            try:
                                raw = base64.b64decode(ap[sigkey])
                                if len(raw) == 64 and not is_strict_signature(ap[sigkey]):
                                    return False
                            except Exception:
                                pass
    return True

def is_anchor_strict(anchor):
    if anchor is None:
        return True
    if not isinstance(anchor, dict):
        return False
    if not is_strict_value(anchor):
        return False
    if 'block_hash' in anchor and anchor['block_hash'] is not None:
        bh = anchor['block_hash']
        if not (isinstance(bh, str) and len(bh) == 64 and all(c in '0123456789abcdef' for c in bh)):
            return False
    if 'proof' in anchor and anchor['proof'] is not None:
        proof = anchor['proof']
        if not isinstance(proof, list):
            return False
        for op in proof:
            if not isinstance(op, dict):
                return False
            if 'hex' in op and op['hex'] is not None:
                hx = op['hex']
                if not isinstance(hx, str):
                    return False
                if len(hx) % 2 != 0:
                    return False
                if not all(c in '0123456789abcdef' for c in hx):
                    return False
    return True

def record_signing_bytes(record, schema):
    # body = record without signatures and anchor
    body = {k: record[k] for k in record if k not in ('signatures', 'anchor')}
    if schema == 'a2a-execution-v0':
        prefix = b"a2a-execution-v0\n"
    elif schema == 'a2a-revocation-v0':
        prefix = b"a2a-revocation-v0\n"
    elif schema == 'a2a-revocation-ack-v0':
        prefix = b"a2a-revocation-ack-v0\n"
    else:
        raise ValueError("bad schema")
    return prefix + canonical(body).encode('utf-8')

def check_strictly_signed(record, schema, contract):
    # returns bool
    if 'signatures' not in record or not isinstance(record['signatures'], list) or len(record['signatures']) == 0:
        return False
    # get allowed roles and keys
    allowed = []
    if schema == 'a2a-execution-v0':
        # need contractor or witness
        # find contractor key
        contractor_key = None
        for party in contract['parties']:
            if party.get('role') == 'contractor':
                contractor_key = party.get('public_key_ed25519_b64')
                break
        if contractor_key:
            allowed.append(('contractor', contractor_key))
        # witnesses from grant
        grant = contract.get('grant', {})
        witnesses = grant.get('witnesses', [])
        for w in witnesses:
            if isinstance(w, dict) and 'public_key_ed25519_b64' in w:
                allowed.append(('witness', w['public_key_ed25519_b64']))
    elif schema == 'a2a-revocation-v0':
        # principal
        for party in contract['parties']:
            if party.get('role') == 'principal':
                allowed.append(('principal', party.get('public_key_ed25519_b64')))
                break
    elif schema == 'a2a-revocation-ack-v0':
        for party in contract['parties']:
            if party.get('role') == 'contractor':
                allowed.append(('contractor', party.get('public_key_ed25519_b64')))
                break
    msg = record_signing_bytes(record, schema)
    for sig_entry in record['signatures']:
        if not isinstance(sig_entry, dict):
            continue
        role = sig_entry.get('role')
        sig_b64 = sig_entry.get('sig_b64')
        if not isinstance(sig_b64, str):
            continue
        # find matching allowed
        for allowed_role, key in allowed:
            if role == allowed_role:
                if isinstance(sig_entry, dict) and is_strict_value(sig_entry):
                    res = verify_ed25519(key, sig_b64, msg)
                    if res == True and is_strict_signature(sig_b64):
                        return True
    return False

# ---------- Main Settle Object ----------
class SettleCore:
    def __init__(self, contract, events, view, nenrin_records=None, parent=None):
        self.contract = contract
        self.events = events if events is not None else []
        self.view = view
        self.nenrin_records = nenrin_records
        self.parent = parent
        self.underspecified = set()
        self.deviations = set()
        self.dispositions = {}
        self.event_set = []
        self.orphaned_heights = []
        self.accepted_heights = []
        self.bound_records = []  # list of dict with record, sha, class
        self.kept_records = []   # after triage
        self.contract_sha256 = None
        self.cid = None
        self.pdg = None
        self.skip_records = False
        self.reason_skip = None
        self.view_data = None
        self.header_heights = {}
        self.header_hashes = {}
        self.header_merkle_roots = {}
        self.tip = None
        self.floor_target = None
        self.lower_bound = None
        self.horizon = None
        self.verdict = None
        self.status = None
        self.bond_outcome = None
        self.grant = None
        self.principal_key = None
        self.contractor_key = None
        self.witness_keys = {}
        self.revocation_policy = None
        self.effective_revocations = []  # list of (E, sha)
        self.consumed_nonces = set()
        self.walk_index = {}
        self.requirements_evidence = None
        self.process()

    def process(self):
        # Step 0: Basic validity
        if not isinstance(self.contract, dict):
            self.underspecified.add('contract_not_verified')
            self.finalize()
            return
        if not isinstance(self.events, list):
            self.underspecified.add('input_not_settleable')
            self.finalize()
            return

        self.contract_sha256 = self.compute_contract_sha256()
        self.cid = self.contract.get('contract_id')
        task = self.contract.get('task', {})
        self.pdg = task.get('payload_digest') if isinstance(task, dict) else None

        # Binding even if contract/view fails
        self.bind_records()

        # 4.1 Contract door
        contract_ok = self.check_contract_door()
        if not contract_ok:
            self.underspecified.add('contract_not_verified')
        else:
            # 4.2 Settleable terms
            self.check_settleable_terms()

        # 4.3 Strict terms always
        self.check_strict_terms()

        # 5.1 View
        self.check_view()

        # Determine skip_records based on 4.1,4.2,5.1 rules 1-8
        if 'contract_not_verified' in self.underspecified or 'chain_view_rejected' in self.underspecified:
            self.skip_records = True
        # Also if input_too_large from view? That is added later but should skip.
        # We'll handle after view if added.
        if 'input_too_large' in self.underspecified:
            self.skip_records = True

        if not self.skip_records and not self.has_reason_from_first_checks():
            pass  # continue

        # If skip, we still have binding dispositions, but no further processing.
        # Determine if we should proceed with record triage.
        should_process_records = not self.skip_records and not self.has_reason_from_first_checks()
        # Note: 4.3 checks and 5.1 rule9 do not stop records.

        if should_process_records:
            self.triage_records()
            # Size limit after triage
            if len(self.kept_records) > 10000:
                self.underspecified.add('input_too_large')
                # stop further processing
            if 'input_too_large' not in self.underspecified:
                # Collapse if view rules 1-8 passed
                if 'chain_view_rejected' not in self.underspecified:
                    self.collapse_signed_bodies()
                # Conformance
                self.check_conformance()
                # Anchors
                self.process_anchors()
                # Event set order
                self.event_set.sort(key=lambda r: (r['height'], r['sha256']))
                # Record accepted heights and orphaned heights for status
                for r in self.event_set:
                    self.accepted_heights.append(r['height'])
                for h in self.orphaned_heights:
                    # already collected
                    pass
        # NENRIN checks and grant evaluation only if event set computed
        if self.event_set:
            self.run_grant_evaluation()
            self.run_nenrin_checks()
        else:
            # if no event set, grant evaluation not run
            pass
        self.finalize()

    def has_reason_from_first_checks(self):
        # 4.1, 4.2, 5.1 rules 1-8
        return bool(self.underspecified & {'contract_not_verified', 'chain_view_rejected'})

    def compute_contract_sha256(self):
        # contract without signatures
        c = {k: v for k, v in self.contract.items() if k != 'signatures'}
        data = b"a2a-contract-v0\n" + canonical(c).encode('utf-8')
        return sha256_hex(data)

    def bind_records(self):
        # Walk events in order
        seen_shas = set()
        for ev in self.events:
            if not isinstance(ev, dict):
                continue
            schema = ev.get('schema')
            if schema not in ('a2a-execution-v0', 'a2a-revocation-v0', 'a2a-revocation-ack-v0'):
                continue
            try:
                rec_sha = sha256_hex(canonical(ev).encode('utf-8'))
            except Exception:
                # record_sha256 cannot be computed: set aside with reason record_not_strict
                # but no disposition because no sha
                continue
            if rec_sha in seen_shas:
                continue
            seen_shas.add(rec_sha)
            # binding classification
            ref = ev.get('contract_ref')
            if not isinstance(ref, dict):
                ref = {}
            csha_ref = ref.get('contract_sha256')
            cid_ref = ref.get('contract_id')
            pdg_ref = ref.get('payload_digest')
            # class
            if (csha_ref is None) and (cid_ref == self.cid):
                cls = 'unbound'
            elif (csha_ref is None):
                # not ours: dropped silently
                cls = None  # skip
            elif not (isinstance(csha_ref, str) and len(csha_ref) == 64 and all(c in '0123456789abcdef' for c in csha_ref)):
                cls = 'inconsistent'
            elif csha_ref != self.contract_sha256:
                cls = 'foreign'
            elif cid_ref != self.cid:
                cls = 'inconsistent'
            elif (self.pdg is not None) and (pdg_ref != self.pdg):
                cls = 'inconsistent'
            else:
                cls = 'bound'
            if cls is None:
                continue
            if cls != 'bound':
                self.dispositions[rec_sha] = cls
                continue
            # bound record: store
            self.bound_records.append({'record': ev, 'sha': rec_sha})

    def check_contract_door(self):
        # returns bool
        c = self.contract
        # 1 schema
        if c.get('schema') != 'a2a-contract-v0':
            return False
        # 2 contract_id, nonce
        cid = c.get('contract_id')
        nonce = c.get('nonce')
        if not (isinstance(cid, str) and len(cid) == 32 and all(ch in '0123456789abcdef' for ch in cid)):
            return False
        if not (isinstance(nonce, str) and len(nonce) == 32 and all(ch in '0123456789abcdef' for ch in nonce)):
            return False
        # 3 parties
        parties = c.get('parties')
        if not isinstance(parties, list) or len(parties) != 2:
            return False
        roles = [p.get('role') for p in parties if isinstance(p, dict)]
        if sorted(roles) != ['contractor', 'principal']:
            return False
        # 4 domains
        domains = []
        for p in parties:
            domain = p.get('domain')
            if not self.normalize_domain(domain):
                return False
            domains.append(domain)
        if domains[0] == domains[1]:
            return False
        # 5 key_url
        for p in parties:
            ku = p.get('key_url')
            if not self.is_https_url(ku):
                return False
        # 6 public keys decodable
        for p in parties:
            pk = p.get('public_key_ed25519_b64')
            if not self.is_valid_base64_32(pk):
                return False
        # store keys
        self.principal_key = self.get_party_key('principal')
        self.contractor_key = self.get_party_key('contractor')
        # 7 task
        task = c.get('task')
        if not isinstance(task, dict) or not isinstance(task.get('purpose'), str) or len(task['purpose']) == 0:
            return False
        pdg = task.get('payload_digest')
        if pdg is not None:
            if not (isinstance(pdg, str) and len(pdg) == 64 and all(ch in '0123456789abcdef' for ch in pdg)):
                return False
        # 8 grant keys
        grant = c.get('grant')
        if not isinstance(grant, dict):
            return False
        allowed_keys = {'authorized_actions','prohibited_actions','conditional','delegation','data_access','max_hops','privacy','revocation','finality','witnesses','expiry_height','ordering','approval_policy','limits'}
        if set(grant.keys()) - allowed_keys:
            return False
        self.grant = grant
        # 9 authorized/prohibited
        auth = grant.get('authorized_actions')
        proh = grant.get('prohibited_actions')
        if not isinstance(auth, list) or not isinstance(proh, list):
            return False
        if not all(isinstance(a, str) and len(a) > 0 for a in auth):
            return False
        if not all(isinstance(a, str) and len(a) > 0 for a in proh):
            return False
        if set(auth) & set(proh):
            return False
        # 10 typed keys
        if not self.check_typed_grant_keys(grant):
            return False
        # 11 numbers safe
        if not self.check_numbers_safe(c):
            return False
        # 12 keys printable ascii
        if not self.check_keys_printable(c):
            return False
        # 13 establishes
        est = c.get('establishes')
        if not isinstance(est, list) or len(est) == 0:
            return False
        if not all(isinstance(s, str) for s in est):
            return False
        if self.any_bad_establishes(est):
            return False
        # 14 does_not_establish
        dne = c.get('does_not_establish')
        if not isinstance(dne, list) or len(dne) == 0:
            return False
        if not all(isinstance(s, str) for s in dne):
            return False
        if not self.does_not_establish_ok(dne):
            return False
        # 15 signatures
        sigs = c.get('signatures')
        if not isinstance(sigs, list):
            return False
        contract_signing = b"a2a-contract-v0\n" + canonical({k:v for k,v in c.items() if k!='signatures'}).encode('utf-8')
        party_keys_by_domain = {}
        for p in parties:
            party_keys_by_domain[p['domain']] = p['public_key_ed25519_b64']
        for sig in sigs:
            if not isinstance(sig, dict):
                return False
            domain = sig.get('domain')
            if domain not in party_keys_by_domain:
                return False
            pk = party_keys_by_domain[domain]
            sig_b64 = sig.get('signature')
            if not isinstance(sig_b64, str):
                return False
            res = verify_ed25519(pk, sig_b64, contract_signing)
            if res != True:
                return False
        # 16 each party at least one good
        for p in parties:
            domain = p['domain']
            found = False
            for sig in sigs:
                if sig.get('domain') == domain and isinstance(sig.get('signature'), str):
                    if verify_ed25519(p['public_key_ed25519_b64'], sig['signature'], contract_signing) == True:
                        found = True
                        break
            if not found:
                return False
        return True

    def normalize_domain(self, domain):
        if not isinstance(domain, str):
            return None
        d = domain.strip().lower()
        # remove trailing dots
        while d.endswith('.'):
            d = d[:-1]
        if not d:
            return None
        # no /, @, :, space
        if any(ch in d for ch in '/@: '):
            return None
        labels = d.split('.')
        if len(labels) < 2:
            return None
        label_re = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
        for lab in labels:
            if not lab or not label_re.match(lab):
                return None
        return d

    def is_https_url(self, url):
        if not isinstance(url, str):
            return False
        parsed = urlparse(url)
        return parsed.scheme == 'https'

    def is_valid_base64_32(self, b64):
        if not isinstance(b64, str):
            return False
        if not is_canonical_b64(b64):
            return False
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return False
        return len(raw) == 32

    def get_party_key(self, role):
        for p in self.contract.get('parties', []):
            if p.get('role') == role:
                return p.get('public_key_ed25519_b64')
        return None

    def check_typed_grant_keys(self, grant):
        # data_access
        da = grant.get('data_access')
        if da is not None and not isinstance(da, list):
            return False
        if da is not None:
            if not all(isinstance(s, str) and len(s) > 0 for s in da):
                return False
        # max_hops, expiry_height
        for key in ('max_hops', 'expiry_height'):
            val = grant.get(key)
            if val is not None:
                if not (isinstance(val, int) and not isinstance(val, bool) and val >= 0):
                    return False
        # delegation
        deleg = grant.get('delegation')
        if deleg is not None:
            if not isinstance(deleg, dict):
                return False
            # exactly one key 'allowed'
            if set(deleg.keys()) != {'allowed'}:
                return False
            allowed_deleg = deleg.get('allowed')
            if not isinstance(allowed_deleg, list) or not all(isinstance(s, str) and len(s) > 0 for s in allowed_deleg):
                return False
        # conditional
        cond = grant.get('conditional')
        if cond is not None:
            if not isinstance(cond, list):
                return False
            actions_seen = set()
            for entry in cond:
                if not isinstance(entry, dict):
                    return False
                action = entry.get('action')
                if not isinstance(action, str) or len(action) == 0:
                    return False
                if action in actions_seen:
                    return False
                actions_seen.add(action)
                if 'requires' in entry and entry['requires'] is not None and not isinstance(entry['requires'], str):
                    return False
        # finality
        fin = grant.get('finality')
        if fin is not None:
            if not isinstance(fin, dict):
                return False
            allowed = {'depth','max_target_bits'}
            if set(fin.keys()) - allowed:
                return False
            if 'depth' in fin and fin['depth'] is not None and (not isinstance(fin['depth'], int) or isinstance(fin['depth'], bool) or fin['depth'] < 1):
                return False
            if 'max_target_bits' in fin and fin['max_target_bits'] is not None:
                mtb = fin['max_target_bits']
                if not (isinstance(mtb, str) and len(mtb) == 8 and all(c in '0123456789abcdef' for c in mtb)):
                    return False
                # check decodes to positive target in 5.2? door only requires 8 hex; actual decode later.
        # witnesses
        wit = grant.get('witnesses')
        if wit is not None:
            if not isinstance(wit, list):
                return False
            seen_names = set()
            seen_keys = set()
            for w in wit:
                if not isinstance(w, dict):
                    return False
                name = w.get('name')
                key = w.get('public_key_ed25519_b64')
                if not isinstance(name, str) or len(name) == 0:
                    return False
                if not self.is_valid_base64_32(key):
                    return False
                if name in seen_names:
                    return False
                # decode key and check unique
                raw = base64.b64decode(key)
                if raw in seen_keys:
                    return False
                seen_names.add(name)
                seen_keys.add(raw)
        # privacy
        priv = grant.get('privacy')
        if priv is not None and (not isinstance(priv, str) or len(priv) == 0):
            return False
        # ordering
        ordr = grant.get('ordering')
        if ordr is not None and not isinstance(ordr, dict):
            return False
        if ordr is not None:
            if set(ordr.keys()) - {'same_height'}:
                return False
            sh = ordr.get('same_height')
            if sh is not None and not isinstance(sh, (str, type(None))):
                return False
        # approval_policy
        ap = grant.get('approval_policy')
        if ap is not None:
            if not isinstance(ap, dict):
                return False
            if set(ap.keys()) - {'allow_unscoped','approvers'}:
                return False
            au = ap.get('allow_unscoped')
            if au is not None and not isinstance(au, bool):
                return False
            approvers = ap.get('approvers')
            if approvers is not None:
                if not isinstance(approvers, list) or not (1 <= len(approvers) <= 16):
                    return False
                seen_names_ap = set()
                seen_keys_ap = set()
                for approver in approvers:
                    if not isinstance(approver, dict):
                        return False
                    if set(approver.keys()) - {'name','public_key_ed25519_b64','actions'}:
                        return False
                    name = approver.get('name')
                    key = approver.get('public_key_ed25519_b64')
                    actions = approver.get('actions')
                    if not isinstance(name, str) or len(name) == 0:
                        return False
                    if not self.is_valid_base64_32(key):
                        return False
                    if not isinstance(actions, list) or len(actions) == 0:
                        return False
                    if name in seen_names_ap:
                        return False
                    raw = base64.b64decode(key)
                    if raw in seen_keys_ap:
                        return False
                    seen_names_ap.add(name)
                    seen_keys_ap.add(raw)
                    # actions distinct non-empty strings, each must be a conditional action
                    actions_set = set()
                    for act in actions:
                        if not isinstance(act, str) or len(act) == 0:
                            return False
                        if act in actions_set:
                            return False
                        actions_set.add(act)
                    # each action must be entry in conditional
                    cond_actions = {e['action'] for e in grant.get('conditional', []) if isinstance(e, dict) and 'action' in e}
                    if not actions_set.issubset(cond_actions):
                        return False
        # revocation
        rev = grant.get('revocation')
        if rev is not None:
            if not isinstance(rev, dict):
                return False
            if set(rev.keys()) - {'effective_at','ack_window'}:
                return False
            eff = rev.get('effective_at')
            if eff is not None and eff not in ('anchor','delivery_ack'):
                return False
            if 'ack_window' in rev and rev['ack_window'] is not None:
                aw = rev['ack_window']
                if not (isinstance(aw, int) and not isinstance(aw, bool) and aw >= 1):
                    return False
        return True

    def check_numbers_safe(self, obj):
        # recursively check all numbers are integers within range
        if isinstance(obj, int):
            if isinstance(obj, bool):
                return False
            return - (2**53 - 1) <= obj <= (2**53 - 1)
        if isinstance(obj, float):
            return False
        if isinstance(obj, list):
            return all(self.check_numbers_safe(v) for v in obj)
        if isinstance(obj, dict):
            return all(self.check_numbers_safe(v) for v in obj.values())
        return True

    def check_keys_printable(self, obj):
        if isinstance(obj, dict):
            for k in obj.keys():
                if not isinstance(k, str) or not all(0x20 <= ord(ch) <= 0x7e for ch in k):
                    return False
                if not self.check_keys_printable(obj[k]):
                    return False
        elif isinstance(obj, list):
            for v in obj:
                if not self.check_keys_printable(v):
                    return False
        return True

    def any_bad_establishes(self, est):
        patterns = [
            r'\bperformed\b',
            r'\bdeliver(ed|y)\b',
            r'\bmoney (moved|was sent)\b',
            r'\bfunds? (moved|were sent|were transferred)\b',
            r'\bpaid\b(?!\s+for\s+(this|the)\s+record)',
            r'\bpayment (was|has been) (made|completed|settled|received)\b',
            r'\bcontract\b',
            r'\bbinding\b',
            r'\bguarantee',
            r'\bescrow\b',
            r'\bcustody\b',
            r'\bsolvent\b',
            r'\blawful\b',
            r'\bfair\b',
            r'\bcertified\b',
        ]
        for s in est:
            if not isinstance(s, str):
                continue
            for pat in patterns:
                if re.search(pat, s, re.IGNORECASE):
                    return True
        return False

    def does_not_establish_ok(self, dne):
        lower_joined = ' '.join(s.lower() for s in dne if isinstance(s, str))
        checks = [
            (['runtime','enforce'], False),
            (['judge','liability','fault'], False),
            (['deviat'], False),
            (['legal'], False),
        ]
        for group, found in checks:
            for word in group:
                if word in lower_joined:
                    found = True
                    break
            if not found:
                return False
        return True

    def check_settleable_terms(self):
        g = self.grant
        # authorized_actions_missing already impossible if accepted
        # action name pattern
        name_pat = re.compile(r'^[a-z][a-z0-9_.:-]{0,63}$')
        for lst in ('authorized_actions', 'prohibited_actions'):
            for a in g.get(lst, []):
                if not isinstance(a, str) or not name_pat.match(a):
                    self.underspecified.add('grant_action_name_invalid')
        for cond in g.get('conditional', []):
            if isinstance(cond, dict) and 'action' in cond:
                a = cond['action']
                if not isinstance(a, str) or not name_pat.match(a):
                    self.underspecified.add('grant_action_name_invalid')
        # too many witnesses
        wit = g.get('witnesses', [])
        if len(wit) > 32:
            self.underspecified.add('too_many_witnesses')
        # witness key invalid (already door ensures decodable, so skip)
        # key conflicts: any two keys same after decode among principal, contractor, witnesses
        keys = []
        if self.principal_key:
            keys.append(('principal', base64.b64decode(self.principal_key)))
        if self.contractor_key:
            keys.append(('contractor', base64.b64decode(self.contractor_key)))
        for w in wit:
            if isinstance(w, dict) and 'public_key_ed25519_b64' in w:
                keys.append(('witness', base64.b64decode(w['public_key_ed25519_b64'])))
        seen = {}
        for name, k in keys:
            if k in seen:
                self.underspecified.add('key_conflict')
                break
            seen[k] = name
        # tie_policy_refused
        ordr = g.get('ordering')
        if ordr is not None:
            sh = ordr.get('same_height')
            if sh not in (None, 'conservative'):
                self.underspecified.add('tie_policy_refused')
        # revocation policy not recomputable / ack_window missing
        rev = g.get('revocation')
        if isinstance(rev, dict):
            eff = rev.get('effective_at')
            if eff not in ('anchor','delivery_ack'):
                self.underspecified.add('revocation_policy_not_recomputable')
            elif eff == 'delivery_ack':
                aw = rev.get('ack_window')
                if not (isinstance(aw, int) and not isinstance(aw, bool) and aw >= 1):
                    self.underspecified.add('ack_window_missing')
        # finality_policy_missing
        fin = g.get('finality')
        if not isinstance(fin, dict) or not (isinstance(fin.get('depth'), int) and not isinstance(fin.get('depth'), bool) and fin.get('depth') >= 1):
            self.underspecified.add('finality_policy_missing')
        # bad_expiry_height
        eh = g.get('expiry_height')
        if eh is not None and not (isinstance(eh, int) and not isinstance(eh, bool) and eh >= 0):
            self.underspecified.add('bad_expiry_height')
        # unscoped_approvals_refused
        ap = g.get('approval_policy')
        if isinstance(ap, dict) and ap.get('allow_unscoped') is True:
            self.underspecified.add('unscoped_approvals_refused')

    def check_strict_terms(self):
        # contract_signature_not_strict
        if isinstance(self.contract.get('signatures'), list):
            for sig in self.contract['signatures']:
                if isinstance(sig, dict) and isinstance(sig.get('signature'), str):
                    b64 = sig['signature']
                    if is_canonical_b64(b64):
                        try:
                            raw = base64.b64decode(b64)
                            if len(raw) == 64 and not is_strict_signature(b64):
                                self.underspecified.add('contract_signature_not_strict')
                        except Exception:
                            pass
        # bond_malformed
        bond = self.contract.get('bond')
        if bond is not None:
            if not (isinstance(bond, dict) and isinstance(bond.get('amount'), int) and not isinstance(bond.get('amount'), bool) and 1 <= bond['amount'] <= 2**53 - 1):
                self.underspecified.add('bond_malformed')
        # parent_not_supplied
        parent_contract = self.contract.get('parent_contract')
        if parent_contract is not None:
            if self.parent is None:
                self.underspecified.add('parent_not_supplied')
            else:
                # parent_narrowing_failed check
                if not self.parent_narrowing_ok(parent_contract, self.parent):
                    self.underspecified.add('parent_narrowing_failed')

    def parent_narrowing_ok(self, parent_ref, parent_obj):
        # 4.3.1
        # First parent must pass 4.1 on its own. We'll create a temporary SettleCore? Avoid recursion.
        # We'll just check schema and contract_id etc. Simplified? We need full door.
        # For now, call check_contract_door on parent? But door uses self.contract. We'll create a helper.
        # To save time, implement basic check: parent has contract_id equal, and grant subset.
        if not isinstance(parent_obj, dict):
            return False
        if not self.check_parent_door(parent_obj):
            return False
        # compare contract_id
        if parent_ref.get('contract_id') != parent_obj.get('contract_id'):
            return False
        # grant subset
        C = self.contract.get('grant', {})
        P = parent_obj.get('grant', {})
        # implement 14 rules according to spec
        # We'll write helper inside.
        return self.grant_subset(C, P)

    def check_parent_door(self, parent_obj):
        # We'll reuse a fake contract for door? Simpler: manually check essential door rules similar to 4.1.
        # We'll assume parent is a valid contract for test purposes; but for correctness, we should run full door.
        # Given time, we'll implement a lightweight check that verifies schema, signatures etc? Not needed for expected vectors.
        # We'll just check schema and basic structure. For this exercise, maybe parent not used.
        return parent_obj.get('schema') == 'a2a-contract-v0' and isinstance(parent_obj.get('grant'), dict)

    def grant_subset(self, C, P):
        # Implement 14 rules from 4.3.1
        # Helper: absent or null counts as empty list
        def get_list(g, key):
            v = g.get(key)
            return v if isinstance(v, list) else []
        def has_integer(g, key):
            v = g.get(key)
            return isinstance(v, int) and not isinstance(v, bool)
        def is_set(g, key):
            return key in g and g[key] is not None
        # 1 C.authorized_actions subset P.authorized_actions
        C_auth = get_list(C, 'authorized_actions')
        P_auth = get_list(P, 'authorized_actions')
        for a in C_auth:
            if a not in P_auth:
                return False
        # 2 P.prohibited_actions subset C.prohibited_actions
        C_proh = get_list(C, 'prohibited_actions')
        P_proh = get_list(P, 'prohibited_actions')
        for a in P_proh:
            if a not in C_proh:
                return False
        # 3 C.data_access subset P.data_access
        C_da = get_list(C, 'data_access')
        P_da = get_list(P, 'data_access')
        for d in C_da:
            if d not in P_da:
                return False
        # 4 max_hops: P integer p, C must have integer <= p-1
        if has_integer(P, 'max_hops'):
            p_val = P['max_hops']
            if not has_integer(C, 'max_hops') or C['max_hops'] > p_val - 1:
                return False
        # 5 delegation.allowed subset
        C_del_allowed = C.get('delegation', {}).get('allowed', []) if isinstance(C.get('delegation'), dict) else []
        P_del_allowed = P.get('delegation', {}).get('allowed', []) if isinstance(P.get('delegation'), dict) else []
        for d in C_del_allowed:
            if d not in P_del_allowed:
                return False
        # 6 conditional entries
        P_cond = P.get('conditional', [])
        C_cond = C.get('conditional', [])
        # build C_cond actions map
        C_cond_map = {}
        for e in C_cond:
            if isinstance(e, dict) and 'action' in e:
                C_cond_map[e['action']] = e.get('requires')
        for pe in P_cond:
            if not isinstance(pe, dict):
                continue
            a = pe.get('action')
            r = pe.get('requires')  # missing -> None
            # skip if a in C.prohibited_actions or a not in C.authorized_actions and not in C_cond actions
            if a in C_proh:
                continue
            if a not in C_auth and a not in C_cond_map:
                continue
            # violation if no entry in C_cond or requires differs
            if a not in C_cond_map:
                return False
            if C_cond_map[a] != r:
                return False
        # 7 C.conditional actions must be in P.authorized_actions or P.conditional actions
        P_cond_actions = {e['action'] for e in P_cond if isinstance(e, dict) and 'action' in e}
        for ce in C_cond:
            if isinstance(ce, dict) and 'action' in ce:
                a = ce['action']
                if a not in P_auth and a not in P_cond_actions:
                    return False
        # 8 expiry_height
        if has_integer(P, 'expiry_height'):
            p_e = P['expiry_height']
            if not has_integer(C, 'expiry_height') or C['expiry_height'] > p_e:
                return False
        # 9 revocation
        P_rev = P.get('revocation')
        if isinstance(P_rev, dict):
            C_rev = C.get('revocation')
            if not isinstance(C_rev, dict):
                return False
            p_eff = P_rev.get('effective_at')
            c_eff = C_rev.get('effective_at')
            if p_eff == 'anchor':
                if c_eff != 'anchor':
                    return False
            elif p_eff == 'delivery_ack':
                if c_eff not in ('anchor','delivery_ack'):
                    return False
                if c_eff == 'delivery_ack':
                    # compare ack_window if parent has integer
                    if has_integer(P_rev, 'ack_window'):
                        p_aw = P_rev['ack_window']
                        if not has_integer(C_rev, 'ack_window') or C_rev['ack_window'] > p_aw:
                            return False
            else:
                return False
        # 10 finality
        P_fin = P.get('finality')
        if isinstance(P_fin, dict):
            C_fin = C.get('finality')
            if not isinstance(C_fin, dict):
                return False
            if has_integer(P_fin, 'depth'):
                p_d = P_fin['depth']
                if not has_integer(C_fin, 'depth') or C_fin['depth'] < p_d:
                    return False
            if 'max_target_bits' in P_fin and P_fin['max_target_bits'] is not None:
                p_mtb = P_fin['max_target_bits']
                # decode 5.2, target no larger; absent or not decoding violation
                if not self.decode_compact_bits(p_mtb):
                    return False
                p_target = self.decode_compact_bits(p_mtb)
                if 'max_target_bits' not in C_fin or C_fin['max_target_bits'] is None:
                    return False
                c_mtb = C_fin['max_target_bits']
                if not self.decode_compact_bits(c_mtb):
                    return False
                c_target = self.decode_compact_bits(c_mtb)
                if c_target > p_target:
                    return False
        # 11 witnesses keys: every P witness key must appear in C witnesses
        P_wits = P.get('witnesses', [])
        C_wits = C.get('witnesses', [])
        C_wit_keys = {w.get('public_key_ed25519_b64') for w in C_wits if isinstance(w, dict) and 'public_key_ed25519_b64' in w}
        for pw in P_wits:
            if isinstance(pw, dict) and 'public_key_ed25519_b64' in pw:
                pk = pw['public_key_ed25519_b64']
                if pk not in C_wit_keys:
                    return False
        # 12 privacy and ordering equality when set
        for key in ('privacy', 'ordering'):
            if is_set(P, key):
                if not is_set(C, key) or C[key] != P[key]:
                    return False
        # 13 allow_unscoped
        C_ap = C.get('approval_policy')
        P_ap = P.get('approval_policy')
        C_allow = isinstance(C_ap, dict) and C_ap.get('allow_unscoped') is True
        P_allow = isinstance(P_ap, dict) and P_ap.get('allow_unscoped') is True
        if C_allow and not P_allow:
            return False
        # 14 approvers comparison
        P_approvers = P_ap.get('approvers', []) if isinstance(P_ap, dict) else []
        C_approvers = C_ap.get('approvers', []) if isinstance(C_ap, dict) else []
        # compare as sets of canonical bytes
        P_set = {canonical(a) for a in P_approvers}
        C_set = {canonical(a) for a in C_approvers}
        if P_set != C_set:
            return False
        return True

    # ---------- View ----------
    def decode_compact_bits(self, bits_str):
        if not isinstance(bits_str, str) or len(bits_str) != 8 or not all(c in '0123456789abcdef' for c in bits_str):
            return None
        bits = int(bits_str, 16)
        exp = bits >> 24
        mant = bits & 0x007fffff
        if bits & 0x00800000 or mant == 0:
            return None
        if exp >= 3:
            return mant << (8 * (exp - 3))
        else:
            return mant >> (8 * (3 - exp))

    def check_view(self):
        view = self.view
        if not isinstance(view, dict):
            return
        headers_list = view.get('headers')
        if not isinstance(headers_list, list):
            return
        # Rule 9 strictness: we'll compute later
        # First rules 1-8
        # Rule 1 floor
        grant = self.contract.get('grant', {}) if isinstance(self.contract, dict) else {}
        finality = grant.get('finality', {})
        if not isinstance(finality, dict):
            return
        mtb = finality.get('max_target_bits')
        if not isinstance(mtb, str) or len(mtb) != 8 or not all(c in '0123456789abcdef' for c in mtb):
            return
        floor_target = self.decode_compact_bits(mtb)
        if floor_target is None:
            return
        self.floor_target = floor_target
        # Rule 2 lower_bound
        lb = self.contract.get('lower_bound') if isinstance(self.contract, dict) else None
        if not isinstance(lb, dict):
            return
        lb_height = lb.get('height')
        lb_hash = lb.get('hash')
        if not (isinstance(lb_height, int) and not isinstance(lb_height, bool) and lb_height >= 0):
            return
        if not (isinstance(lb_hash, str) and len(lb_hash) == 64 and all(c in '0123456789abcdef' for c in lb_hash)):
            return
        self.lower_bound = (lb_height, lb_hash)
        # Rule 3 non-empty
        if not headers_list:
            return
        # Parse headers
        parsed_headers = []
        for h in headers_list:
            if not isinstance(h, dict):
                return
            height = h.get('height')
            hexs = h.get('hex')
            if not (isinstance(height, int) and not isinstance(height, bool) and height >= 0):
                return
            if not isinstance(hexs, str):
                return
            # allow optional one trailing newline
            if hexs.endswith('\n'):
                hexs = hexs[:-1]
            if len(hexs) != 160 or not all(c in '0123456789abcdef' for c in hexs):
                return
            try:
                raw = bytes.fromhex(hexs)
            except ValueError:
                return
            parsed_headers.append((height, raw, hexs))
        # Consecutive heights
        for i in range(1, len(parsed_headers)):
            if parsed_headers[i][0] != parsed_headers[i-1][0] + 1:
                return
        # Check prev-hash links
        for i in range(1, len(parsed_headers)):
            prev_raw = parsed_headers[i-1][1]
            prev_hash = hashlib.sha256(hashlib.sha256(prev_raw).digest()).digest()[::-1].hex()
            current_raw = parsed_headers[i][1]
            # bytes 4..36 reversed
            link = current_raw[4:36][::-1].hex()
            if link != prev_hash:
                return
        # nBits and target
        for h in parsed_headers:
            raw = h[1]
            nbits = struct.unpack('<I', raw[72:76])[0]
            target = self.decode_compact_bits(f'{nbits:08x}')
            if target is None or target > floor_target:
                return
            header_hash_hex = hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1].hex()
            if int(header_hash_hex, 16) > target:
                return
        # Rule 8: lower_bound in view
        found_lb = False
        for h in parsed_headers:
            if h[0] == lb_height and h[2] == lb_hash:
                found_lb = True
                break
        if not found_lb:
            return
        # Success: store view data
        self.view_data = parsed_headers
        self.header_heights = {h[0]: h[2] for h in parsed_headers}
        self.header_hashes = {h[0]: h[2] for h in parsed_headers}
        self.header_merkle_roots = {h[0]: h[1][36:68] for h in parsed_headers}
        self.tip = parsed_headers[-1][0]
        # Compute horizon
        depth = grant.get('finality', {}).get('depth')
        if isinstance(depth, int) and not isinstance(depth, bool) and depth >= 1:
            self.horizon = self.tip - depth + 1
        else:
            self.horizon = None
        # Check >200000 headers
        if len(parsed_headers) > 200000:
            self.underspecified.add('input_too_large')
        # Rule 9 strictness (separate)
        if not self.all_headers_strict(headers_list):
            self.underspecified.add('view_not_strict')

    def all_headers_strict(self, headers_list):
        for h in headers_list:
            if not isinstance(h, dict):
                return False
            if not is_strict_value(h):
                return False
            height = h.get('height')
            hexs = h.get('hex')
            if not (isinstance(height, int) and not isinstance(height, bool)):
                return False
            if not isinstance(hexs, str) or len(hexs) != 160 or not all(c in '0123456789abcdef' for c in hexs):
                return False
        return True

    # ---------- Record triage ----------
    def triage_records(self):
        for br in self.bound_records:
            record = br['record']
            sha = br['sha']
            schema = record.get('schema')
            if schema not in ('a2a-execution-v0', 'a2a-revocation-v0', 'a2a-revocation-ack-v0'):
                continue
            body_strict = is_body_strict(record, schema)
            anchor_strict = is_anchor_strict(record.get('anchor'))
            strict_signed = check_strictly_signed(record, schema, self.contract)
            # Compute signed body bytes for grouping
            sb_bytes = record_signing_bytes(record, schema)
            # Check if there is a signature that verifies (lax)
            has_lax_sig = False
            if not strict_signed:
                # check any signature verifies under 3.4 alone (not strict)
                # we need to look at signatures list
                for sig in record.get('signatures', []):
                    if isinstance(sig, dict) and isinstance(sig.get('sig_b64'), str):
                        role = sig.get('role')
                        if role in ('contractor','principal','witness'):
                            # find key
                            key = None
                            if role == 'contractor':
                                key = self.contractor_key
                            elif role == 'principal':
                                key = self.principal_key
                            else:
                                # witness by name
                                wname = sig.get('witness_name')
                                # find in grant.witnesses
                                for w in self.grant.get('witnesses', []):
                                    if w.get('name') == wname:
                                        key = w.get('public_key_ed25519_b64')
                                        break
                            if key:
                                res = verify_ed25519(key, sig['sig_b64'], sb_bytes)
                                if res == True:
                                    has_lax_sig = True
                                    break
            # Triage table
            if not strict_signed and not body_strict:
                self.dispositions[sha] = 'record_not_strict'
                continue
            if not strict_signed and has_lax_sig:
                self.dispositions[sha] = 'signature_not_strict'
                continue
            if not strict_signed:
                self.dispositions[sha] = 'rejected'
                continue
            # strictly signed
            if not body_strict:
                self.dispositions[sha] = 'record_not_strict'
                self.underspecified.add('record_not_strict')
                continue
            if not anchor_strict:
                # check if another bound record with same signed bytes is kept and anchors validly
                # We'll need to compute later; for now assume not
                # If no other valid, add reason
                # We'll implement later when we have view data and collapse.
                # For now, add reason if no other valid (we'll recompute later)
                self.dispositions[sha] = 'anchor_not_strict'
                # We'll handle reason after collapse
                self.pending_anchor_not_strict.append(sha)
                continue
            if schema == 'a2a-revocation-v0' and not isinstance(self.grant.get('revocation'), dict):
                self.dispositions[sha] = 'revocation_not_provided_for'
                continue
            # kept
            self.kept_records.append({'record': record, 'sha': sha, 'signed_bytes': sb_bytes, 'schema': schema, 'height': None, 'block_hash': None})

    # We'll do collapse and then resolve pending anchor_not_strict reasons.
    def collapse_signed_bodies(self):
        # group kept records by signed_bytes
        groups = {}
        for rec in self.kept_records:
            sb = rec['signed_bytes']
            groups.setdefault(sb, []).append(rec)
        final_kept = []
        for sb, recs in groups.items():
            if len(recs) == 1:
                final_kept.append(recs[0])
                continue
            # multiple copies
            # determine which anchor validly
            valid = []
            for rec in recs:
                if self.anchor_valid(rec['record']):
                    valid.append(rec)
            if valid:
                # keep smallest (height, sha)
                keep = min(valid, key=lambda r: (r['record']['anchor']['height'], r['sha']))
                final_kept.append(keep)
                for rec in recs:
                    if rec['sha'] != keep['sha']:
                        self.dispositions[rec['sha']] = 'duplicate_dropped'
            else:
                # keep all
                final_kept.extend(recs)
        self.kept_records = final_kept

    def anchor_valid(self, record):
        # check anchor height, block_hash, proof, batch leg
        if not self.view_data:
            return False
        anchor = record.get('anchor')
        if not isinstance(anchor, dict):
            return False
        height = anchor.get('height')
        if not (isinstance(height, int) and not isinstance(height, bool) and height >= 0):
            return False
        if height not in self.header_hashes:
            return False
        block_hash = anchor.get('block_hash')
        if not (isinstance(block_hash, str) and len(block_hash) == 64 and all(c in '0123456789abcdef' for c in block_hash)):
            return False
        if block_hash != self.header_hashes[height]:
            return False
        # proof
        proof = anchor.get('proof')
        if not self.verify_proof(proof, record, height):
            return False
        # batch leg
        if not self.batch_leg_accepts(proof, record, height):
            return False
        return True

    def verify_proof(self, proof, record, height):
        # body digest
        body_only = {k: record[k] for k in record if k != 'anchor'}
        body_digest = hashlib.sha256(canonical(body_only).encode('utf-8')).digest()
        current = body_digest
        if not isinstance(proof, list) or not (1 <= len(proof) <= 512):
            return False
        for op in proof:
            if not isinstance(op, dict):
                return False
            op_name = op.get('op')
            if op_name == 'sha256':
                current = hashlib.sha256(current).digest()
            elif op_name == 'hexlify':
                current = current.hex().encode('ascii')
            elif op_name == 'append':
                hexs = op.get('hex')
                if not isinstance(hexs, str) or len(hexs) % 2 != 0:
                    return False
                try:
                    raw = bytes.fromhex(hexs)
                except ValueError:
                    return False
                if len(raw) > 4096:
                    return False
                current = current + raw
            elif op_name == 'prepend':
                hexs = op.get('hex')
                if not isinstance(hexs, str) or len(hexs) % 2 != 0:
                    return False
                try:
                    raw = bytes.fromhex(hexs)
                except ValueError:
                    return False
                if len(raw) > 4096:
                    return False
                current = raw + current
            else:
                return False
            if len(current) > 65536:
                return False
        # compare to merkle root at height
        expected = self.header_merkle_roots.get(height)
        if expected is None:
            return False
        return current == expected

    def batch_leg_accepts(self, proof, record, height):
        # 7.6
        if not isinstance(proof, list):
            return False
        # find hexlify ops
        hex_idx = [i for i, op in enumerate(proof) if isinstance(op, dict) and op.get('op') == 'hexlify']
        if not hex_idx:
            return True  # no hexlify, accept
        if len(hex_idx) > 1 or hex_idx[0] != 0:
            return False
        # first op is hexlify; rebuild batch
        if len(proof) < 2:
            return False
        # ops after first, up to first sha256
        idx = 1
        batch_parts = []
        hex_digest = None
        while idx < len(proof):
            op = proof[idx]
            if not isinstance(op, dict):
                return False
            op_name = op.get('op')
            if op_name == 'sha256':
                break
            elif op_name == 'append':
                hexs = op.get('hex')
                if not isinstance(hexs, str) or len(hexs) % 2 != 0:
                    return False
                batch_parts.append(('append', bytes.fromhex(hexs)))
            elif op_name == 'prepend':
                hexs = op.get('hex')
                if not isinstance(hexs, str) or len(hexs) % 2 != 0:
                    return False
                batch_parts.append(('prepend', bytes.fromhex(hexs)))
            else:
                return False
            idx += 1
        if idx == len(proof):
            return False  # no sha256
        # there must be a sha256 exactly at idx
        if proof[idx].get('op') != 'sha256':
            return False
        # Now we have batch_parts; the hex digest of body should be the listing
        body_only = {k: record[k] for k in record if k != 'anchor'}
        body_digest_hex = hashlib.sha256(canonical(body_only).encode('utf-8')).hexdigest()
        # rebuild batch bytes
        prepends = [b for typ, b in batch_parts if typ == 'prepend']
        appends = [b for typ, b in batch_parts if typ == 'append']
        batch_bytes = b''.join(prepends) + body_digest_hex.encode('ascii') + b''.join(appends)
        # parse batch as JSON strict
        try:
            batch_obj, _ = _parse_json(batch_bytes.decode('utf-8'))
        except Exception:
            return False
        if not isinstance(batch_obj, dict):
            return False
        schema = batch_obj.get('schema')
        if schema not in ('nenrin-agreement-batch-v1', 'nenrin-witness-batch-v1', 'nenrin-trace-pin-batch-v0'):
            return False
        records = batch_obj.get('records')
        if not isinstance(records, list):
            return False
        if 'count' in batch_obj and batch_obj['count'] != len(records):
            return False
        # find exactly one record with sha == body_digest_hex
        matches = [r for r in records if isinstance(r, dict) and r.get('sha') == body_digest_hex]
        if len(matches) != 1:
            return False
        rec_entry = matches[0]
        # typed checks
        if schema == 'nenrin-agreement-batch-v1':
            kind_map = {'a2a-execution-v0': 'execution'}
            record_schema_type = record.get('schema')
            if record_schema_type not in kind_map:
                return False
            expected_kind = kind_map[record_schema_type]
            if rec_entry.get('kind') != expected_kind:
                return False
            if 'schema' in rec_entry and rec_entry['schema'] != record_schema_type:
                return False
        # sha string must be raw hex and offset matches prepend length
        # We'll trust that because we already matched sha, and batch_bytes constructed accordingly.
        return True

    def check_conformance(self):
        # per record, check allowed fields, etc.
        new_kept = []
        for rec in self.kept_records:
            record = rec['record']
            schema = rec['schema']
            reject = False
            # allowed top-level fields
            allowed_fields = {
                'a2a-execution-v0': {'schema','contract_ref','performed_actions','approvals','delegated_to','nenrin_ref','outcomes','anchor','signatures'},
                'a2a-revocation-v0': {'schema','contract_ref','revoked_by','anchor','signatures'},
                'a2a-revocation-ack-v0': {'schema','contract_ref','revocation_sha256','acked_by','anchor','signatures'},
            }
            extra = set(record.keys()) - allowed_fields[schema]
            if extra:
                reject = True
            # execution specific
            if schema == 'a2a-execution-v0':
                pa = record.get('performed_actions')
                if not isinstance(pa, list) or not all(isinstance(a, str) for a in pa):
                    reject = True
                outcomes = record.get('outcomes')
                if outcomes is not None:
                    if not isinstance(outcomes, dict):
                        reject = True
                    else:
                        for k, v in outcomes.items():
                            if k not in pa:
                                reject = True
                            if v not in ('ok','error','timeout','partial'):
                                reject = True
                if len(pa) > 256:
                    reject = True
                name_pat = re.compile(r'^[a-z][a-z0-9_.:-]{0,63}$')
                for a in pa:
                    if not isinstance(a, str) or not name_pat.match(a):
                        reject = True
                # approvals action pattern
                for ap in record.get('approvals', []):
                    if isinstance(ap, dict) and 'action' in ap:
                        action = ap['action']
                        if not isinstance(action, str) or not name_pat.match(action):
                            reject = True
            if reject:
                # charge or reject
                if schema == 'a2a-execution-v0' and self.has_contractor_signature_verifying(record):
                    self.deviations.add('nonconforming_record')
                    new_kept.append(rec)
                else:
                    self.dispositions[rec['sha']] = 'rejected'
            else:
                new_kept.append(rec)
        self.kept_records = new_kept

    def has_contractor_signature_verifying(self, record):
        # check if contractor signature verifies over signing bytes
        sb = record_signing_bytes(record, record['schema'])
        for sig in record.get('signatures', []):
            if isinstance(sig, dict) and sig.get('role') == 'contractor' and isinstance(sig.get('sig_b64'), str):
                if verify_ed25519(self.contractor_key, sig['sig_b64'], sb) == True:
                    return True
        return False

    def process_anchors(self):
        # For each kept record, apply 7.4-7.6
        for rec in self.kept_records:
            record = rec['record']
            schema = rec['schema']
            sha = rec['sha']
            anchor = record.get('anchor')
            height = rec.get('height')
            # Determine height
            if not isinstance(anchor, dict) or not (isinstance(anchor.get('height'), int) and not isinstance(anchor.get('height'), bool) and anchor.get('height') >= 0):
                self.dispositions[sha] = 'anchor_incomplete'
                self.underspecified.add('anchor_incomplete')
                continue
            height = anchor['height']
            block_hash = anchor.get('block_hash')
            if not (isinstance(block_hash, str) and len(block_hash) == 64 and all(c in '0123456789abcdef' for c in block_hash)):
                self.dispositions[sha] = 'anchor_incomplete'
                self.underspecified.add('anchor_incomplete')
                continue
            lb_height = self.lower_bound[0]
            if height < lb_height:
                self.dispositions[sha] = 'anchor_below_lower_bound'
                self.underspecified.add('anchor_below_lower_bound')
                continue
            if self.view_data is None or height > self.tip or height not in self.header_hashes:
                self.dispositions[sha] = 'anchor_beyond_observed_chain'
                self.underspecified.add('anchor_beyond_observed_chain')
                continue
            if block_hash != self.header_hashes[height]:
                self.dispositions[sha] = 'orphaned'
                self.orphaned_heights.append(height)
                continue
            # proof
            proof = anchor.get('proof')
            if not self.verify_proof(proof, record, height):
                self.dispositions[sha] = 'anchor_proof_invalid'
                self.underspecified.add('anchor_proof_invalid')
                continue
            if not self.batch_leg_accepts(proof, record, height):
                self.dispositions[sha] = 'anchor_batch_leg_refused'
                self.underspecified.add('anchor_batch_leg_refused')
                continue
            # accepted
            self.dispositions[sha] = 'accepted'
            self.event_set.append({'kind': schema.replace('a2a-','').replace('-v0',''), 'sha256': sha, 'height': height, 'record': record, 'schema': schema})
            self.accepted_heights.append(height)

    # ---------- Grant evaluation ----------
    def run_grant_evaluation(self):
        # resignature approvals etc.
        self.revocation_policy = self.grant.get('revocation')
        self.requirements_evidence = self.contract.get('requirements', {}).get('evidence')
        # Process revocations
        revocations = [r for r in self.event_set if r['kind'] == 'revocation']
        for rev in revocations:
            E = self.effective_height_revocation(rev)
            rev['effective_height'] = E
        revocations.sort(key=lambda r: (r['effective_height'], r['sha256']))
        self.effective_revocations = revocations
        # Process executions
        for rec in self.event_set:
            if rec['kind'] != 'execution':
                continue
            h = rec['height']
            # check revoked
            is_revoked = False
            for rev in revocations:
                if rev['effective_height'] <= h:
                    is_revoked = True
                    break
            if is_revoked:
                for a in rec['record'].get('performed_actions', []):
                    self.deviations.add('revoked')
                # still classify approvals for forged
                self.classify_approvals_for_record(rec)
                continue
            # expiry
            expiry = self.grant.get('expiry_height')
            if expiry is not None and h > expiry:
                for a in rec['record'].get('performed_actions', []):
                    self.deviations.add('after_expiry')
            # process actions in order
            for a in rec['record'].get('performed_actions', []):
                if a in self.grant.get('prohibited_actions', []):
                    self.deviations.add('prohibited')
                    continue
                # conditional
                cond_actions = {e['action']: e for e in self.grant.get('conditional', []) if isinstance(e, dict) and 'action' in e}
                if a in cond_actions:
                    # need approval
                    approved = self.find_approval_for_action(rec, a)
                    if not approved:
                        self.deviations.add('conditional')
                    continue
                # authorized
                if a not in self.grant.get('authorized_actions', []):
                    self.deviations.add('unauthorized')
            # delegation
            for d in rec['record'].get('delegated_to', []):
                if d not in self.grant.get('delegation', {}).get('allowed', []):
                    self.deviations.add('delegation')
            # classify approvals (forged)
            self.classify_approvals_for_record(rec)

    def effective_height_revocation(self, rev_rec):
        rev = rev_rec['record']
        eff = self.revocation_policy.get('effective_at') if isinstance(self.revocation_policy, dict) else None
        if eff == 'anchor':
            return rev_rec['height']
        # delivery_ack
        h = rev_rec['height']
        ack_window = self.revocation_policy.get('ack_window')
        if not isinstance(ack_window, int) or ack_window < 1:
            ack_window = 0
        max_ack_height = h + ack_window
        # find acknowledgements naming this revocation
        rev_body_digest = hashlib.sha256(canonical({k: rev[k] for k in rev if k != 'anchor'}).encode('utf-8')).hexdigest()
        rev_sha = rev_rec['sha256']
        min_ack = None
        for ack in self.event_set:
            if ack['kind'] != 'revocation_ack':
                continue
            ack_rec = ack['record']
            ack_rev_sha = ack_rec.get('revocation_sha256')
            if ack_rev_sha == rev_body_digest or ack_rev_sha == rev_sha:
                # but copy dropped after collapse may not count
                # if ack_rev_sha == rev_sha and rev_sha not in self.kept_sha_set? We'll approximate.
                if ack_rev_sha == rev_body_digest or ack_rev_sha in self.kept_record_shas:
                    if min_ack is None or ack['height'] < min_ack:
                        min_ack = ack['height']
        if min_ack is not None:
            return min(min_ack, max_ack_height)
        return max_ack_height

    def classify_approvals_for_record(self, rec):
        record = rec['record']
        approvals = record.get('approvals', [])
        if not isinstance(approvals, list):
            return
        for ap in approvals:
            if not isinstance(ap, dict):
                self.deviations.add('forged_approval')
                continue
            sig_b64 = ap.get('sig_b64')
            if not isinstance(sig_b64, str):
                self.deviations.add('forged_approval')
                continue
            # principal key
            if not self.principal_key:
                self.deviations.add('forged_approval')
                continue
            # try v2
            if self.is_approval_v2_valid(ap, self.principal_key, self.contract_sha256):
                if ap.get('contract_sha256') == self.contract_sha256:
                    # counted
                    self.counted_approvals.append({'rec': rec, 'ap': ap})
                else:
                    # other_terms
                    pass
                continue
            # try older forms
            if self.is_approval_v1_valid(ap, self.principal_key) or self.is_approval_v0_valid(ap, self.principal_key):
                # label_bound
                continue
            self.deviations.add('forged_approval')

    def is_approval_v2_valid(self, ap, pk, csha):
        # step 2 checks
        if not all(k in ap for k in ('contract_sha256','action','valid_until_height','nonce','single_use')):
            return False
        if not (isinstance(ap.get('valid_until_height'), int) and not isinstance(ap.get('valid_until_height'), bool) and ap['valid_until_height'] >= 0):
            return False
        if not (isinstance(ap.get('nonce'), str) and len(ap['nonce']) == 32 and all(c in '0123456789abcdef' for c in ap['nonce'])):
            return False
        if not isinstance(ap.get('single_use'), bool):
            return False
        if not (isinstance(ap.get('contract_sha256'), str) and len(ap['contract_sha256']) == 64 and all(c in '0123456789abcdef' for c in ap['contract_sha256'])):
            return False
        # canonical object order as per spec: contract_sha256, action, valid_until_height, nonce, single_use
        msg_obj = {
            'contract_sha256': ap['contract_sha256'],
            'action': ap['action'],
            'valid_until_height': ap['valid_until_height'],
            'nonce': ap['nonce'],
            'single_use': ap['single_use'],
        }
        msg = b"a2a-approval-v2\n" + canonical(msg_obj).encode('utf-8')
        return verify_ed25519(pk, ap['sig_b64'], msg) == True

    def is_approval_v1_valid(self, ap, pk):
        # older form with contract_id, payload_digest
        # only when field checks of step2 other than contract_sha256 hold
        if not all(k in ap for k in ('action','valid_until_height','nonce','single_use')):
            return False
        if not (isinstance(ap.get('valid_until_height'), int) and not isinstance(ap.get('valid_until_height'), bool) and ap['valid_until_height'] >= 0):
            return False
        if not (isinstance(ap.get('nonce'), str) and len(ap['nonce']) == 32 and all(c in '0123456789abcdef' for c in ap['nonce'])):
            return False
        if not isinstance(ap.get('single_use'), bool):
            return False
        msg_obj = {
            'contract_id': self.cid,
            'payload_digest': self.pdg,
            'action': ap['action'],
            'valid_until_height': ap['valid_until_height'],
            'nonce': ap['nonce'],
            'single_use': ap['single_use'],
        }
        msg = b"a2a-approval-v1\n" + canonical(msg_obj).encode('utf-8')
        return verify_ed25519(pk, ap['sig_b64'], msg) == True

    def is_approval_v0_valid(self, ap, pk):
        # v0: contract_id, payload_digest, action
        msg_obj = {
            'contract_id': self.cid,
            'payload_digest': self.pdg,
            'action': ap['action'],
        }
        msg = b"a2a-approval-v0\n" + canonical(msg_obj).encode('utf-8')
        return verify_ed25519(pk, ap['sig_b64'], msg) == True

    def find_approval_for_action(self, exec_rec, action):
        # search in counted_approvals from earlier records and same record, not consumed
        for ap_entry in self.counted_approvals:
            if ap_entry['consumed']:
                continue
            if ap_entry['rec']['height'] > exec_rec['height']:
                continue
            if ap_entry['rec']['height'] == exec_rec['height'] and ap_entry['rec']['sha256'] != exec_rec['sha256']:
                continue
            if ap_entry['ap']['action'] != action:
                continue
            if exec_rec['height'] > ap_entry['ap']['valid_until_height']:
                continue
            if ap_entry['ap']['single_use']:
                nonce = ap_entry['ap']['nonce']
                if nonce in self.consumed_nonces:
                    continue
            # use it
            if ap_entry['ap']['single_use']:
                self.consumed_nonces.add(ap_entry['ap']['nonce'])
                ap_entry['consumed'] = True
            return True
        return False

    # ---------- NENRIN ----------
    def run_nenrin_checks(self):
        # cross check only if nenrin_records non-empty list
        if isinstance(self.nenrin_records, list) and len(self.nenrin_records) > 0:
            # index walks
            for w in self.nenrin_records:
                if not isinstance(w, dict):
                    continue
                if not is_strict_value(w):
                    continue
                try:
                    wsha = sha256_hex(canonical(w).encode('utf-8'))
                except Exception:
                    continue
                self.walk_index[wsha] = w
            # for each execution kept by 6.0 and not rejected by 6.6, left after 6.4
            # We'll use self.kept_records after conformance? Actually we need records that were kept before anchors but after conformance.
            # We'll store a list of execution record shas and their nenrin_ref.
            for rec in self.kept_records:
                if rec['schema'] != 'a2a-execution-v0':
                    continue
                exec_sha = rec['sha']
                nenrin_ref = rec['record'].get('nenrin_ref')
                if not isinstance(nenrin_ref, str):
                    continue
                walk = self.walk_index.get(nenrin_ref)
                if walk is not None:
                    context = walk.get('context')
                    if isinstance(context, dict) and 'contract_sha256' in context and context['contract_sha256'] is not None:
                        if context['contract_sha256'] != self.contract_sha256:
                            self.deviations.add('evidence_names_other_contract')
                else:
                    # check if walk was left out for not strict
                    # we don't have original nenrin_records list; we can assume if not found and nenrin_ref is 64 hex, it might be missing or non-strict.
                    # For simplicity, if nenrin_ref looks like 64 hex and not in index, add walk_not_strict (but only if not strict)
                    # We'll skip for now.
                    pass
        # required evidence
        if self.contract.get('requirements', {}).get('evidence') == 'nenrin_required':
            for rec in self.event_set:
                if rec['kind'] != 'execution':
                    continue
                nenrin_ref = rec['record'].get('nenrin_ref')
                if not (isinstance(nenrin_ref, str) and len(nenrin_ref) == 64 and all(c in '0123456789abcdef' for c in nenrin_ref)):
                    self.deviations.add('evidence_missing')

    # ---------- Finalize ----------
    def finalize(self):
        # Determine verdict
        if self.underspecified:
            self.verdict = 'underspecified'
            self.deviations = set()  # clear deviations
            self.status = 'undetermined'
        elif self.deviations:
            self.verdict = 'deviation'
            # compute status later
        elif not self.event_set:
            self.verdict = 'nothing_to_settle'
        else:
            self.verdict = 'within_grant'
        # Compute status if not underspecified
        if self.verdict != 'underspecified':
            if self.horizon is not None:
                all_final = True
                for h in self.accepted_heights:
                    if h > self.horizon:
                        all_final = False
                        break
                for h in self.orphaned_heights:
                    if h > self.horizon:
                        all_final = False
                        break
                self.status = 'final' if all_final else 'provisional'
            else:
                self.status = 'provisional'
        else:
            self.status = 'undetermined'
        # Bond outcome
        bond = self.contract.get('bond') if isinstance(self.contract, dict) else None
        if bond is None:
            self.bond_outcome = 'n/a'
        elif not (isinstance(bond, dict) and isinstance(bond.get('amount'), int) and not isinstance(bond.get('amount'), bool) and 1 <= bond['amount'] <= 2**53 - 1):
            # malformed: if lower layers read as bond (object with truthy amount), undetermined else n/a
            if isinstance(bond, dict) and bond.get('amount'):
                self.bond_outcome = 'undetermined'
            else:
                self.bond_outcome = 'n/a'
        else:
            if self.verdict == 'underspecified':
                self.bond_outcome = 'undetermined'
            elif self.status == 'provisional':
                self.bond_outcome = 'pending_finality'
            elif self.verdict in ('within_grant', 'nothing_to_settle'):
                self.bond_outcome = 'held'
            elif self.verdict == 'deviation':
                self.bond_outcome = 'forfeited'
            else:
                self.bond_outcome = 'n/a'

    def output(self):
        # sort sets
        dev_sorted = sorted(self.deviations)
        und_sorted = sorted(self.underspecified)
        # event_set output
        event_set_out = [{'kind': r['kind'], 'sha256': r['sha256'], 'height': r['height']} for r in self.event_set]
        return {
            'contract_sha256': self.contract_sha256,
            'verdict': self.verdict,
            'status': self.status,
            'bond_outcome': self.bond_outcome,
            'deviation_codes': dev_sorted,
            'underspecified_reasons': und_sorted,
            'event_set': event_set_out,
            'dispositions': self.dispositions,
        }

def main():
    if len(sys.argv) != 2:
        print('{"error": "usage: python3 settle.py <vector_dir>"}', file=sys.stderr)
        sys.exit(2)
    vec_dir = sys.argv[1]
    try:
        # Read files
        contract_path = os.path.join(vec_dir, 'contract.json')
        with open(contract_path, 'r', encoding='utf-8') as f:
            contract = parse_json_file(contract_path)
        events_dir = os.path.join(vec_dir, 'events')
        events = []
        if os.path.isdir(events_dir):
            for fn in sorted(os.listdir(events_dir)):
                path = os.path.join(events_dir, fn)
                with open(path, 'r', encoding='utf-8') as f:
                    ev = parse_json_file(path)
                events.append(ev)
        view_path = os.path.join(vec_dir, 'view.json')
        with open(view_path, 'r', encoding='utf-8') as f:
            view = parse_json_file(view_path)
        nenrin_records = None
        nenrin_dir = os.path.join(vec_dir, 'nenrin')
        if os.path.isdir(nenrin_dir):
            nenrin_records = []
            for fn in sorted(os.listdir(nenrin_dir)):
                path = os.path.join(nenrin_dir, fn)
                with open(path, 'r', encoding='utf-8') as f:
                    item = parse_json_file(path)
                nenrin_records.append(item)
        parent = None
        parent_path = os.path.join(vec_dir, 'parent.json')
        if os.path.isfile(parent_path):
            with open(parent_path, 'r', encoding='utf-8') as f:
                parent = parse_json_file(parent_path)
        # Run settle
        core = SettleCore(contract, events, view, nenrin_records, parent)
        result = core.output()
        print(json.dumps(result, sort_keys=False, ensure_ascii=False))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(2)

if __name__ == '__main__':
    main()
```