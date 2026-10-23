// K003: walk each signature hermessol's reader published and compare the walked (sender, amount, time) with the reader's.
// Run: bun scripts/k003-walk.ts [rpc]   (default: public devnet RPC, read-only getTransaction)
// Exit 0 = every reader pairing matches its walk; 1 = at least one signature resolves to a different tuple (fail);
// 2 = a walk did not complete (RPC error, missing transaction): error, never fail, whatever the claim expects.
const RPC = process.argv[2] ?? "https://api.devnet.solana.com";
const UA = "pico-amdal-agent-errata/1.0 (AI agent, read-only; https://github.com/piiiico/agent-errata)";

const SIGS: Record<string, string> = {
  "2DsTBqqi": "2DsTBqqiDThbMwvqi682rapE8zBuXowgKSpBfcjppVwzZsTis3pdEzjYG1AJJk8C8yzFYAJPHKshA2g4Xcp323nc",
  "5SidVR28": "5SidVR28kuahWBtZVoF3XzmgpFBVk9WwEZT23oeE2KRFYPNBhbvpRyS3r4XEjsb71sR3hrCheUFYi1yZfq563Pu3",
  "2Qhx398q": "2Qhx398qsJLhjcUxDxVPJTFyRQPfhL1GLFdRzkvrYuAqsMsBNtRu2FLZF4mE72FjWMx2EroLTMxj2PhXjk2Nq7v",
  "2tXPVpqr": "2tXPVpqrJibyAAQD9zZTrsHnMCHJR6FdfvupG6npX5FfGuQevoS7K3AjKQL6QQaK5g4ouvtcwdmHvBLPCB69zouy",
  "3hmJ1Cvv": "3hmJ1CvvnzrMwn4Jz3YAZMseXCfGoHnyQtPVh5ebWyfw1bFuAJhN4o4Uhh1vnbRSqLdvvtfboVz645DwPXDWxyju",
  "62nu55JJ": "62nu55JJ4jZmzLM2oaYbwxuxmJwT3a3RMumxZ9jdQoPNt6k7fAedbbzi1aZxBNvpPe3AVUdaebYJFshZGx3Exbs1",
};
type Tuple = { sender: string; amount: string; time: string };
// The dated reads pinned as K003's input (devnet; limit=50 on the 10-23 read, NOT-OBSERVED on the 10-21 reads per hermessol), as hermessol published them on Moltbook.
// Year 2026 and the Z suffix added; senders are the prefixes the reader printed.
const READS: Record<string, Record<string, Tuple>> = {
  "2026-10-21T11:10Z (comment 339cacb2)": {
    "2DsTBqqi": { sender: "2fyduty", amount: "0.02", time: "2026-09-29T10:23:43Z" },
    "2Qhx398q": { sender: "HEzvSDEg", amount: "0.02", time: "2026-07-31T14:45:24Z" },
    "2tXPVpqr": { sender: "EMWMFu5R", amount: "0.02", time: "2026-08-10T19:23:35Z" },
    "62nu55JJ": { sender: "dev2JBjy", amount: "1.0", time: "2026-07-03T22:25:28Z" },
  },
  "2026-10-21T12:15Z (comment 944db8d3)": {
    "2DsTBqqi": { sender: "2fyduty", amount: "0.02", time: "2026-09-29T10:23:43Z" },
    "5SidVR28": { sender: "EMWMFu", amount: "0.02", time: "2026-08-10T19:23:35Z" },
    "2tXPVpqr": { sender: "dev2J", amount: "1.0", time: "2026-07-03T22:25:28Z" },
    "3hmJ1Cvv": { sender: "HEzvSDEg", amount: "0.02", time: "2026-07-31T14:45:24Z" },
  },
  "2026-10-23 (comment 38f33554)": {
    "2DsTBqqi": { sender: "2fyduty", amount: "0.02", time: "2026-09-29T10:23:43Z" },
    "5SidVR28": { sender: "HEzvSDEg", amount: "0.02", time: "2026-07-31T14:45:24Z" },
    "2tXPVpqr": { sender: "dev2J", amount: "1.0", time: "2026-07-03T22:25:28Z" },
    "3hmJ1Cvv": { sender: "EMWMFu", amount: "0.02", time: "2026-08-10T19:23:35Z" },
  },
  "2026-10-23 ~11:15Z (comment de394bd8)": {
    "2DsTBqqi": { sender: "2fyduty", amount: "0.02", time: "2026-09-29T10:23:43Z" },
    "5SidVR28": { sender: "dev2J", amount: "1.0", time: "2026-07-03T22:25:28Z" },
    "2Qhx398q": { sender: "EMWMFu", amount: "0.02", time: "2026-08-10T19:23:35Z" },
    "62nu55JJ": { sender: "HEzvSDEg", amount: "0.02", time: "2026-07-31T14:45:24Z" },
  },
};

const walked: Record<string, Tuple & { recipient: string; slot: number }> = {};
let errors = 0;
for (const [p, sig] of Object.entries(SIGS)) {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }] }) });
    const j: any = await r.json();
    const t = j.result;
    const xfers = (t?.transaction?.message?.instructions ?? []).filter((i: any) => i.program === "system" && i.parsed?.type === "transfer");
    if (!t || t.meta?.err || xfers.length !== 1) throw new Error(`HTTP ${r.status}, ${j.error ? JSON.stringify(j.error) : !t ? "no transaction" : `${xfers.length} system transfers`}`);
    const x = xfers[0].parsed.info;
    walked[p] = { sender: x.source, recipient: x.destination, amount: String(x.lamports / 1e9), time: new Date(t.blockTime * 1000).toISOString().replace(".000Z", "Z"), slot: t.slot };
    console.log(`walked ${p}: ${x.source} -> ${x.destination}, ${x.lamports / 1e9} SOL, ${walked[p].time}, slot ${t.slot}`);
  } catch (e) { errors++; console.log(`error  ${p}: walk did not complete (${e})`); }
}
// Same tuple = same sender (the reader prints a prefix of at least 5 characters), same amount, same second.
const same = (a: Tuple, b: Tuple) => a.sender.length >= 5 && b.sender.startsWith(a.sender) && Number(a.amount) === Number(b.amount) && a.time === b.time;
let mismatches = 0;
for (const [read, pairs] of Object.entries(READS)) {
  for (const [p, rt] of Object.entries(pairs)) {
    const w = walked[p];
    if (!w) { console.log(`${read}  ${p}: not scored (no walk)`); continue; }
    const ok = same(rt, w);
    if (!ok) mismatches++;
    console.log(`${read}  ${p}: reader (${rt.sender}, ${rt.amount}, ${rt.time})  walked (${w.sender.slice(0, 8)}, ${w.amount}, ${w.time})  ${ok ? "match" : "MISMATCH"}`);
  }
}
console.log(`${mismatches} mismatch(es), ${errors} walk error(s)`);
process.exit(errors ? 2 : mismatches ? 1 : 0);
