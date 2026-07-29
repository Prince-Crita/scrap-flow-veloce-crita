// Full 27-step production validation for the review fixes.
const BASE = process.env.BASE_URL || "http://localhost:3001";
// Credentials default to the disposable sandbox yard (tests/fixtures.ts) so these
// suites never write test rows into Yard 1, the production baseline.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "test-owner@veloce.test";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "testowner123";
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || "test-manager@veloce.test";
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || "testmanager123";
let cookies = {};
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
function store(res){ const raw=res.headers.getSetCookie?res.headers.getSetCookie():[]; for(const c of raw){const [p]=c.split(";");const i=p.indexOf("=");cookies[p.slice(0,i)]=p.slice(i+1);} }
async function req(path, opts={}){ const res=await fetch(BASE+path,{...opts,headers:{...(opts.headers||{}),cookie:ch()},redirect:"manual"}); store(res); return res; }
const jget = (p)=>req(p).then(r=>r.json());
const jpost = (p,b,m="POST")=>req(p,{method:m,headers:{"content-type":"application/json"},body:b===undefined?undefined:JSON.stringify(b)});
async function login(email,password){ cookies={}; const {csrfToken}=await jget("/api/auth/csrf"); const body=new URLSearchParams({csrfToken,email,password,callbackUrl:BASE+"/stock",json:"true"}); await req("/api/auth/callback/credentials",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:body.toString()}); }
const qty = (stock,name)=> stock.skus.find(s=>s.name===name)?.quantityKg;
let pass=0, fail=0;
function check(label, cond, extra=""){ if(cond){pass++; console.log(`  âœ“ ${label}`);} else {fail++; console.log(`  âœ— ${label} ${extra}`);} }

async function main(){
  console.log("[1] Login as Owner");
  await login(OWNER_EMAIL,OWNER_PASSWORD);
  const sess = await jget("/api/auth/session");
  check("owner session", sess?.user?.role==="OWNER");

  console.log("[2] Add new vendor");
  const vRes = await (await jpost("/api/vendors",{name:"E2E Vendor",gstNumber:"27E2E1234F1Z9",phone:"9000000000"})).json();
  const vendorId = vRes.vendor.id;
  check("vendor created", !!vendorId);

  console.log("[3] Add new material (X -> Mixed X)");
  const matName = "Copper" + Math.random().toString(36).slice(2,6).toUpperCase();
  const mRes = await (await jpost("/api/materials",{name:matName,category:"Non-ferrous"})).json();
  check("material created", mRes.material?.name===`Mixed ${matName}`, JSON.stringify(mRes));
  const mats = await jget("/api/materials");
  check("new material in chip list", mats.materials.some(m=>m.name===`Mixed ${matName}`));
  const mixMs = mats.materials.find(m=>m.name==="Mixed MS");

  console.log("[4-8] Camera workflow: upload images + OCR");
  const front = await (await jpost("/api/uploads",{dataUrl:PNG,kind:"vehicle-front"})).json();
  const back = await (await jpost("/api/uploads",{dataUrl:PNG,kind:"vehicle-back"})).json();
  const mat1 = await (await jpost("/api/uploads",{dataUrl:PNG,kind:"material",index:0})).json();
  const mat2 = await (await jpost("/api/uploads",{dataUrl:PNG,kind:"material",index:1})).json();
  check("front uploaded", !!front.url);
  check("back uploaded", !!back.url);
  const ocr = await (await jpost("/api/ocr",{image:PNG,imageBack:PNG})).json();
  check("OCR returns (fallback ok)", ocr.fallback===true || typeof ocr.plate==="string" || ocr.plate===null);

  console.log("[9-10] Add weights 480+520+200 and SAVE LOAD");
  let stock = await jget("/api/stock");
  const msBefore = qty(stock,"Mixed MS");
  const load = await (await jpost("/api/inward/loads",{
    materialSkuId: mixMs.id, vendorId, entries:[480,520,200],
    vehicleNumber:"TN38AB4587", vehicleType:"6-Wheel Truck", driverName:"E2E Driver",
    frontImageUrl:front.url, backImageUrl:back.url, materialImageUrls:[mat1.url,mat2.url]
  })).json();
  check("load saved with lot", !!load.load?.lotNumber);
  check("total is 1200", load.load?.totalKg===1200, `got ${load.load?.totalKg}`);

  console.log("[11] Confirm stock +1200");
  stock = await jget("/api/stock");
  check("Mixed MS increased by 1200", qty(stock,"Mixed MS")===msBefore+1200, `${msBefore}->${qty(stock,"Mixed MS")}`);

  console.log("[12-13] Sort page: select the same vendor lot");
  const pending = await jget("/api/sort/pending");
  const lot = pending.lots.find(l=>l.lotNumber===load.load.lotNumber);
  check("lot appears in selector", !!lot);
  check("lot shows vehicle", lot?.vehicleNumber==="TN38AB4587");
  const bazar = lot.targets.find(t=>t.name==="MS Bazar");
  const comm = lot.targets.find(t=>t.name==="MS Commercial");
  const sup = lot.targets.find(t=>t.name==="MS Super");
  const bB=qty(stock,"MS Bazar"), cB=qty(stock,"MS Commercial"), sB=qty(stock,"MS Super");

  console.log("[14-16] Segregate 500/400/250/50 and verify");
  const sort = await (await jpost("/api/sort/complete",{loadId:lot.loadId,wastageKg:50,
    allocations:[{skuId:bazar.skuId,kg:500},{skuId:comm.skuId,kg:400},{skuId:sup.skuId,kg:250}]})).json();
  check("sort completed", !!sort.lotNumber, JSON.stringify(sort));
  check("wastage pct ~4.17", Math.abs(sort.wastagePct-4.17)<0.01, `got ${sort.wastagePct}`);
  stock = await jget("/api/stock");
  check("Mixed MS back to start", qty(stock,"Mixed MS")===msBefore, `${qty(stock,"Mixed MS")}`);
  check("MS Bazar +500", qty(stock,"MS Bazar")===bB+500);
  check("MS Commercial +400", qty(stock,"MS Commercial")===cB+400);
  check("MS Super +250", qty(stock,"MS Super")===sB+250);

  console.log("[17] Stock traceability: E2E Vendor attributed to MS Bazar");
  const bazarId = stock.skus.find(s=>s.name==="MS Bazar").id;
  const sources = await jget(`/api/stock/${bazarId}/sources`);
  const e2eSrc = sources.sources.find(x=>x.vendorName==="E2E Vendor");
  check("E2E Vendor source present", !!e2eSrc, JSON.stringify(sources.sources));
  check("attributed 500kg via TN38AB4587", e2eSrc?.addedKg===500 && e2eSrc?.vehicleNumber==="TN38AB4587");

  console.log("[18-19] READY TO SELL threshold gating");
  const ready = await jget("/api/sell/ready");
  check("MS Bazar now ready (>=2000)", ready.ready.some(r=>r.name==="MS Bazar"));

  console.log("[20-22] Complete a sale -> invoice + receivable");
  const bazarNow = qty(stock,"MS Bazar");
  const sale = await (await jpost("/api/sales",{skuId:bazarId,buyerName:"E2E Buyer",quantityKg:2000,ratePerKg:34,gstRate:18,vehicleNumber:"KA01CD1234",driverName:"Sale Driver"})).json();
  check("invoice generated", /^INV-\d{4}$/.test(sale.sale?.invoiceNumber||""), sale.sale?.invoiceNumber);
  stock = await jget("/api/stock");
  // Phase 4: a sale ALLOCATES stock, it does not remove it. The kilograms leave
  // the yard only when the Manager loads a vehicle in Outward.
  check("stock NOT deducted by the sale (allocation only)", qty(stock,"MS Bazar")===bazarNow, `${qty(stock,"MS Bazar")} vs ${bazarNow}`);
  // Dispatching is the MANAGER's job — the Owner sells, the Manager loads.
  // Switching sessions here is the point, not an inconvenience: it proves the
  // allocation survives the handover between the two roles.
  const ownerCookies = { ...cookies };
  await login(MANAGER_EMAIL,MANAGER_PASSWORD);
  const queue = await jget("/api/outward/queue");
  const alloc = queue.pending.find(a=>a.invoiceNumber===sale.sale.invoiceNumber);
  check("the sale appears in the Manager's outward queue", !!alloc);
  check("the allocation balance is the full quantity", alloc?.balanceKg===2000, String(alloc?.balanceKg));
  const disp = await (await jpost("/api/outward/dispatch",{lines:[{saleId:alloc.saleId,kg:2000}],vehicleNumber:"KA01CD1234",vehicleType:"Truck",driverName:"Sale Driver"})).json();
  check("dispatch recorded", /^D-\d{4}$/.test(disp.dispatch?.dispatchNumber||""), JSON.stringify(disp));
  stock = await jget("/api/stock");
  check("stock deducted 2000 by the DISPATCH", qty(stock,"MS Bazar")===bazarNow-2000, `${qty(stock,"MS Bazar")} vs ${bazarNow-2000}`);
  // Back to the Owner for the remaining owner-scoped assertions.
  cookies = ownerCookies;
  const ready2 = await jget("/api/sell/ready");
  check("receivable created", ready2.receivables.some(r=>r.invoiceNumber===sale.sale.invoiceNumber));

  console.log("[23-24] Reports popup content");
  const salesRep = await jget("/api/sales");
  const rep = salesRep.sales.find(s=>s.invoiceNumber===sale.sale.invoiceNumber);
  check("sale in reports", !!rep);
  check("report has payment status", rep?.paymentStatus==="PENDING");
  check("report has customer+material+qty+amount", rep?.buyerName==="E2E Buyer" && rep?.skuName==="MS Bazar" && rep?.quantityKg===2000 && rep?.total>0);

  console.log("[25-27] Manager restrictions");
  await login(MANAGER_EMAIL,MANAGER_PASSWORD);
  const mSell = await req("/api/sell/ready");
  check("manager blocked from sell", mSell.status===403);
  const mVend = await req("/api/vendors",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"x"})});
  check("manager blocked from add vendor", mVend.status===403);
  const mMat = await req("/api/materials",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"x"})});
  check("manager blocked from add material", mMat.status===403);
  const mDel = await req(`/api/vendors/${vendorId}`,{method:"DELETE"});
  check("manager blocked from delete vendor", mDel.status===403);

  console.log("\n[extra] Owner soft-delete + restore vendor");
  await login(OWNER_EMAIL,OWNER_PASSWORD);
  const del = await (await req(`/api/vendors/${vendorId}`,{method:"DELETE"})).json();
  check("vendor soft-deleted", del.active===false);
  const activeList = await jget("/api/vendors");
  check("inactive hidden from list", !activeList.vendors.some(v=>v.id===vendorId));
  const allList = await jget("/api/vendors?all=1");
  check("inactive visible in ?all=1", allList.vendors.some(v=>v.id===vendorId && v.active===false));
  const restore = await (await jpost(`/api/vendors/${vendorId}`,{active:true},"PATCH")).json();
  check("vendor restored", restore.active===true);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail>0?1:0);
}
main().catch(e=>{console.error("E2E CRASHED:",e);process.exit(1);});
