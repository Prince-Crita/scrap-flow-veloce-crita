/**
 * Item-6 regression: after SAVE LOAD the lot must appear immediately in the
 * Sort selector with the correct vendor + material, for all four combinations
 * of (existing|new vendor) Ã— (existing|new material).
 *
 * Usage: start the app, then `node tests/inward-sort.test.mjs`.
 * Mutates data â€” run `npm run db:reset` afterwards.
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
let pass=0, fail=0;
const check=(l,c,x="")=>{ if(c){pass++;console.log(`  âœ“ ${l}`);} else {fail++;console.log(`  âœ— ${l} ${x}`);} };
const uniq = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function existingVendorId(){ const v=await jget("/api/vendors"); return v.vendors.find(x=>x.name==="Balaji Metals").id; }
async function newVendorId(){ const r=await jpost("/api/vendors",{name:`Vendor ${uniq()}`}); return r.vendor.id; }
async function existingMaterial(){ const m=await jget("/api/materials"); const b=m.materials.find(x=>x.name==="Mixed MS"); return { skuId:b.id, label:"Mixed MS", sortable:true }; }
async function newMaterial(){ const nm=`Metal${uniq()}`; const r=await jpost("/api/materials",{name:nm}); return { skuId:r.material.id, label:`Mixed ${nm}`, sortable:false }; }

async function runCase(label, vendorKind, materialKind){
  console.log(`\n[${label}]`);
  const vendorId = vendorKind==="existing" ? await existingVendorId() : await newVendorId();
  const vendorName = (await jget("/api/vendors")).vendors.find(v=>v.id===vendorId)?.name;
  const mat = materialKind==="existing" ? await existingMaterial() : await newMaterial();

  const load = await jpost("/api/inward/loads",{ materialSkuId: mat.skuId, vendorId, entries:[400,200], vehicleNumber:`V${uniq()}`, vehicleType:"Other", driverName:"T" });
  check("load saved", !!load.load?.lotNumber, JSON.stringify(load));

  const pending = await jget("/api/sort/pending");
  const lot = pending.lots.find(l=>l.lotNumber===load.load.lotNumber);
  check("lot appears in Sort selector immediately", !!lot);
  if(lot){
    check("correct vendor attached", lot.vendorName===vendorName, `${lot.vendorName} vs ${vendorName}`);
    check("correct material attached", lot.materialLabel===mat.label, `${lot.materialLabel} vs ${mat.label}`);
    check("total 600kg", lot.totalKg===600);
    check(`sortable=${mat.sortable}`, lot.sortable===mat.sortable, `got ${lot.sortable}`);
  }
}

async function main(){
  await login(OWNER_EMAIL,OWNER_PASSWORD);
  await runCase("existing vendor + existing material","existing","existing");
  await runCase("existing vendor + new material","existing","new");
  await runCase("new vendor + existing material","new","existing");
  await runCase("new vendor + new material","new","new");
  console.log(`\n==== inwardâ†’sort: ${pass} passed, ${fail} failed ====`);
  process.exit(fail>0?1:0);
}
main().catch(e=>{console.error("CRASHED:",e);process.exit(1);});
