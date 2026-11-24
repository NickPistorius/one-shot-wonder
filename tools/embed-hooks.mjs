// Copies tools/hooks.json into year-by-year.html as one line: const HOOKS={"key":[ms,dur],...};
// Usage: node tools/embed-hooks.mjs
import {readFileSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const here=p=>fileURLToPath(new URL(p,import.meta.url));
const htmlPath=here("../year-by-year.html"),jsonPath=here("./hooks.json");
const A="/*HOOKS*/",B="/*END-HOOKS*/";
const fail=m=>{console.error("embed-hooks: "+m);process.exit(1)};

const html=readFileSync(htmlPath,"utf8");
const a=html.indexOf(A),b=html.indexOf(B);
if(a<0||b<0||html.indexOf(A,a+1)>=0||html.indexOf(B,b+1)>=0)fail("need exactly one "+A+" and one "+B+" marker in year-by-year.html");
if(b<a)fail("markers are in the wrong order");

let src;try{src=JSON.parse(readFileSync(jsonPath,"utf8"))}catch(e){fail("cannot read tools/hooks.json: "+e.message)}
if(!src||typeof src!=="object"||Array.isArray(src))fail("tools/hooks.json must be an object");
const out={};
for(const k of Object.keys(src).sort()){
  const h=src[k];
  if(!h||!Number.isFinite(h.ms)||!Number.isFinite(h.dur))fail("bad entry for "+k+": ms and dur must be numbers");
  out[k]=[Math.round(h.ms),Math.round(h.dur)];
}
const body="const HOOKS="+JSON.stringify(out)+";";
const next=html.slice(0,a+A.length)+body+html.slice(b);
if(next!==html)writeFileSync(htmlPath,next);
console.log("embedded "+Object.keys(out).length+" hooks"+(next===html?" (no change)":""));
