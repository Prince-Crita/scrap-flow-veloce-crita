/**
 * Item-7 regression tests: inward save must always update stock correctly and
 * transactionally. Covers single weighment, multiple weighments, different
 * material types, and repeated loads.
 *
 * Usage: start the app (npm run start), then `node tests/inward.test.mjs`.
 * Mutates data â€” run `npm run db:reset` afterwards to restore demo state.
 */
const BASE = process.env.BASE_URL || "http://localhost:3001";
// Credentials default to the disposable sandbox yard (tests/fixtures.ts) so these
// suites never write test rows into Yard 1, the production baseline.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "test-owner@veloce.test";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "testowner123";
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || "test-manager@veloce.test";
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || "testmanager123";
let cookies = {};
const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
function store(res){ const raw=res.headers.getSetCookie?res.headers.getSetCookie():[]; for(const c of raw){const [p]=c.split(";");const i=p.indexOf("=");cookies[p.slice(0,i)]=p.slice(i+1);} }
async function req(path, opts={}){ const res=await fetch(BASE+path,{...opts,headers:{...(opts.headers||{}),cookie:ch()},redirect:"manual"}); store(res); return res; }
const jget = (p)=>req(p).then(r=>r.json());
const jpost = (p,b)=>req(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
async function login(email,password){ cookies={}; const {csrfToken}=await jget("/api/auth/csrf"); const body=new URLSearchParams({csrfToken,email,password,callbackUrl:BASE+"/stock",json:"true"}); await req("/api/auth/callback/credentials",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:body.toString()}); }
const qty = (stock,name)=> stock.skus.find(s=>s.name===name)?.quantityKg;
let pass=0, fail=0;
const check=(l,c,x="")=>{ if(c){pass++;console.log(`  âœ“ ${l}`);} else {fail++;console.log(`  âœ— ${l} ${x}`);} };

async function saveLoad(materialSkuId, entries){
  return jpost("/api/inward/loads",{ materialSkuId, entries, vehicleNumber:"TEST0000", vehicleType:"Other", driverName:"Tester" });
}

async function main(){
  await login(OWNER_EMAIL,OWNER_PASSWORD);
  const mats = await jget("/api/materials");
  const mixMs = mats.materials.find(m=>m.name==="Mixed MS").id;
  const mixPet = mats.materials.find(m=>m.name==="PET Mixed").id;

  // 1) single weighment
  let s = await jget("/api/stock"); const a = qty(s,"Mixed MS");
  await saveLoad(mixMs,[300]);
  s = await jget("/api/stock");
  check("single weighment +300", qty(s,"Mixed MS")===a+300, `${a}->${qty(s,"Mixed MS")}`);

  // 2) multiple weighments
  const b = qty(s,"Mixed MS");
  const r = await saveLoad(mixMs,[100,200,50]);
  check("multi total is 350", r.load.totalKg===350);
  s = await jget("/api/stock");
  check("multiple weighments +350", qty(s,"Mixed MS")===b+350);

  // 3) different material type (PET)
  const p = qty(s,"PET Mixed");
  await saveLoad(mixPet,[250]);
  s = await jget("/api/stock");
  check("different material PET +250", qty(s,"PET Mixed")===p+250);

  // 4) repeated loads
  const c = qty(s,"Mixed MS");
  await saveLoad(mixMs,[111]);
  await saveLoad(mixMs,[222]);
  s = await jget("/api/stock");
  check("repeated loads +333", qty(s,"Mixed MS")===c+333);

  // unique lot numbers
  const l1 = await saveLoad(mixMs,[10]);
  const l2 = await saveLoad(mixMs,[10]);
  check("lot numbers unique", l1.load.lotNumber!==l2.load.lotNumber, `${l1.load.lotNumber} vs ${l2.load.lotNumber}`);

  console.log(`\n==== inward: ${pass} passed, ${fail} failed ====`);
  process.exit(fail>0?1:0);
}
main().catch(e=>{console.error("CRASHED:",e);process.exit(1);});
