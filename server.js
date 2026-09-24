import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockedStepReason,
  blockedDeliveryReason,
} from "./quality-rules.js";
import {
  loadStore,
  listRecords,
  activeRecords,
  findCase,
  reportException,
  submitRework,
  reviewRework,
  correctBorehole,
  correctSliceId,
} from "./quality-records.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    [data-quality-slice] { margin-top:8px; } [data-quality-slice] select,[data-quality-slice] input { margin-top:6px; }
    [data-quality-slice] button,[data-quality-sample] button { margin-top:6px; background:#8a5a2b; width:100%; }
    .qc-box { border:1px dashed #b7a98f; border-radius:6px; padding:8px 10px; margin-top:8px; background:#faf7f0; }
    .qc-title { font-weight:700; font-size:13px; color:#5c4a2e; } .qc-warn { background:#f6e3d0; border:1px solid #d49a6a; color:#7a3f12; border-radius:6px; padding:6px 8px; font-size:12px; margin:6px 0; }
    .qc-report { font-size:12px; color:var(--muted); margin:6px 0; } .qc-photo { max-width:120px; max-height:90px; border:1px solid var(--line); border-radius:4px; margin-top:4px; }
    .qc-rework { font-size:12px; color:var(--muted); margin:6px 0; } .qc-closed { color:var(--accent); font-size:12px; font-weight:700; margin:6px 0; }
    .qc-hist { font-size:11px; color:var(--muted); margin:2px 0; } .qc-details { margin-top:6px; font-size:12px; } .qc-status { font-weight:400; color:var(--stone); }
    .qc-void { font-size:12px; color:#9a3a2e; margin:4px 0; } .qc-fix { margin-top:8px; } .qc-fix button { background:var(--stone); }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤和交付</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    let samples = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function render() {
      window.samples = samples; window.api = api;
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>'+sample.project+'</h3><span class="pill">'+sample.status+'</span><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div><div data-quality-sample="'+sample.id+'"></div><label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+sample.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div><div data-quality-slice="'+sample.id+'|'+slice.id+'"></div></div>').join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        try {
          await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
          await load();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        try {
          await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
          await load();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => {
        try { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); }
        catch (e) { alert(e.message); }
      });
      if (window.afterRender) window.afterRender();
    }
    async function load(){ samples = await api("/api/samples"); render(); }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
  <script src="/public/quality-page.js"></script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const store = await loadStore();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/public/quality-page.js") {
      const file = await readFile(join(__dirname, "public", "quality-page.js"), "utf8");
      res.writeHead(200, { "Content-Type":"application/javascript; charset=utf-8" });
      return res.end(file);
    }
    if (req.method === "GET" && url.pathname === "/api/quality-records") return sendJson(res, 200, listRecords(store));
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      const openCase = findCase(store, sample, slice);
      const reason = openCase ? blockedStepReason(openCase, input.step) : null;
      if (reason) return sendJson(res, 409, { error: reason });
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const qualityReport = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/quality-report$/);
    if (qualityReport && req.method === "POST") {
      const sample = db.samples.find(item => item.id === qualityReport[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === qualityReport[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      try {
        const record = await reportException(store, sample, slice, await body(req));
        const at = new Date().toISOString();
        slice.logs.push({ at, step: "研磨", note: `质量异常上报（${record.id}：${record.reports[record.reports.length - 1].type}），退出观察与交付，退回研磨` });
        sample.status = "制片中";
        await saveDb(db);
        return sendJson(res, 201, record);
      } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    }
    const qualityRework = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/quality-rework$/);
    if (qualityRework && req.method === "POST") {
      const sample = db.samples.find(item => item.id === qualityRework[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === qualityRework[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      try {
        const record = await submitRework(store, sample, slice, await body(req));
        slice.logs.push({ at: new Date().toISOString(), step: "研磨", note: `返工登记（${record.id}）：${record.rework.reason}，耗材批号 ${record.rework.materialLot}，新厚度 ${record.rework.thickness}μm` });
        await saveDb(db);
        return sendJson(res, 200, record);
      } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    }
    const qualityReview = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/quality-review$/);
    if (qualityReview && req.method === "POST") {
      const sample = db.samples.find(item => item.id === qualityReview[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === qualityReview[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      try {
        const record = await reviewRework(store, sample, slice, await body(req));
        slice.logs.push({ at: new Date().toISOString(), step: slice.status, note: `返工复核通过（${record.id}）：复核人 ${record.review.reviewer}，可继续制片` });
        await saveDb(db);
        return sendJson(res, 200, record);
      } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    }
    const fixBorehole = url.pathname.match(/^\/api\/samples\/([^/]+)\/correct-borehole$/);
    if (fixBorehole && req.method === "POST") {
      const sample = db.samples.find(item => item.id === fixBorehole[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      try {
        const voided = await correctBorehole(store, sample, (await body(req)).borehole);
        await saveDb(db);
        return sendJson(res, 200, { borehole: sample.borehole, voided });
      } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    }
    const fixSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/correct-slice-id$/);
    if (fixSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === fixSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === fixSlice[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      try {
        const voided = await correctSliceId(store, sample, slice, (await body(req)).sliceId);
        await saveDb(db);
        return sendJson(res, 200, { sliceId: slice.id, voided });
      } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const deliveryBlocked = blockedDeliveryReason(activeRecords(store), sample.id);
      if (deliveryBlocked) return sendJson(res, 409, { error: deliveryBlocked });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
