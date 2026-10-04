// Reads /workspace/tmp/s006/snaps.json = distinct CLAUDE.md snapshots [{t,c}] (146 distinct of 173 rows). Unit = sentence (our lines are paragraphs). Prints kept/total for all pairs and split by new/old length ratio.
// S006 protocol on pico's CLAUDE.md snapshots (Dione's masked-coordinate matcher, adapted: unit = sentence, not line)
import { readFileSync } from "fs";
const snaps: {t:string,c:string}[] = JSON.parse(readFileSync("/workspace/tmp/s006/snaps.json","utf8"));
const DATE = /\b(?:20\d\d-)?(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\d\d\b/g;
const norm = (d:string)=> d.replace(/^20\d\d-/,"");
function segs(c:string){ const out:{s:string,head:string[]}[]=[]; let head:string[]=[];
  for (const line of c.split("\n")) {
    if (/^#+\s/.test(line)) { head = line.match(DATE)?.map(norm) ?? []; continue; }
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z*(“"])/)) { const t=s.trim(); if (t.length>20) out.push({s:t, head}); }
  } return out; }
const toks = (s:string)=> new Set(s.replace(DATE," ").replace(/\b[0-9a-f]{8,}\b/gi," ").replace(/\d+/g," ").toLowerCase().match(/[\p{L}]{3,}/gu) ?? []);
function run(minShared:number, fNew:number, fOld:number){
  const res = {inline:[0,0], head:[0,0], pairs:[] as any[]}; const produced = new Set<string>();
  for (let i=1;i<snaps.length;i++){
    const A=segs(snaps[i-1].c), B=segs(snaps[i].c); const bset=new Set(B.map(x=>x.s)), aset=new Set(A.map(x=>x.s));
    const removed=A.filter(x=>!bset.has(x.s)), added=B.filter(x=>!aset.has(x.s)).map(x=>({...x,tk:toks(x.s)}));
    for (const o of removed){
      if (produced.has(o.s)) continue; // not a FIRST condensation
      const inl=(o.s.match(DATE)??[]).map(norm); const pos = inl.length? "inline" : o.head.length? "head": null; if(!pos) continue;
      const ot=toks(o.s); let best:any=null, bs=0;
      for (const n of added){ if (n.s.length>=o.s.length) continue; let sh=0; for(const w of n.tk) if(ot.has(w)) sh++;
        if (sh>=minShared && sh>=fNew*n.tk.size && sh>=fOld*ot.size && sh>bs){bs=sh;best=n;} }
      if(!best) continue;
      produced.add(best.s);
      const dates = pos==="inline"?inl:o.head; const nd=new Set([...(best.s.match(DATE)??[]).map(norm), ...best.head]);
      const kept = dates.some(d=>nd.has(d));
      (res as any)[pos][1]++; if(kept)(res as any)[pos][0]++;
      res.pairs.push({ratio:+(best.s.length/o.s.length).toFixed(2),t:snaps[i].t.slice(0,10),pos,kept,old:o.s.slice(0,220),new:best.s.slice(0,220)});
    }
  } return res; }
const variants:[number,number,number][]= [[4,.5,.25],[3,.5,.25],[5,.5,.25],[4,.4,.2],[4,.6,.3],[4,.5,.4],[6,.6,.4]];
for (const v of variants){ const r=run(...v); const c=r.pairs.filter((x:any)=>x.ratio<0.7), e=r.pairs.filter((x:any)=>x.ratio>=0.7); console.log(JSON.stringify(v),"all",r.inline.join("/"),"cut<0.7",c.filter((x:any)=>x.kept).length+"/"+c.length,"edit>=0.7",e.filter((x:any)=>x.kept).length+"/"+e.length); }

