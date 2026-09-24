// 质量异常处置页面操作：挂载到主页面的切片卡片/样本卡片上，
// 提供异常上报（类型/实测厚度/照片/发现人）、返工登记、他人复核、编号更正。

(function () {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = at => new Date(at).toLocaleString("zh-CN", { hour12: false });

  async function readPhoto(input) {
    const file = input && input.files && input.files[0];
    if (!file) return "";
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("照片读取失败"));
      reader.readAsDataURL(file);
    });
  }

  function reportForm(sid, slid) {
    return `<div data-qc-box>
      <div class="qc-title">质量异常处置</div>
      <select name="qc-type"><option>空片</option><option>连片</option><option>厚度偏差</option></select>
      <input name="qc-thickness" type="number" step="0.1" placeholder="实测厚度（微米）">
      <input name="qc-photo" type="file" accept="image/*">
      <input name="qc-finder" placeholder="发现人">
      <button data-qc-report="${sid}|${slid}">上报异常（退回研磨）</button>
    </div>`;
  }

  function reworkForm() {
    return `<div data-qc-box>
      <div class="qc-warn">异常片已退出观察与交付，请登记返工</div>
      <input name="qc-reason" placeholder="返工原因">
      <input name="qc-lot" placeholder="耗材批号">
      <input name="qc-new-thickness" type="number" step="0.1" placeholder="返工后新厚度（25~35微米）">
      <input name="qc-reworker" placeholder="返工操作人">
      <button data-qc-rework>提交返工</button>
    </div>`;
  }

  function reviewForm() {
    return `<div data-qc-box>
      <input name="qc-reviewer" placeholder="复核人（须与返工操作人不同）">
      <button data-qc-review>复核通过后继续</button>
    </div>`;
  }

  function casePanel(record, sid, slid) {
    const photos = record.reports.map((r, i) =>
      `<div class="qc-report">第${i + 1}次上报：${esc(r.type)} · 实测 ${r.thickness}μm · 发现人 ${esc(r.finder)} · ${fmt(r.at)}` +
      (r.photo ? `<br><img class="qc-photo" src="${r.photo}" alt="异常片照片">` : "") +
      `</div>`).join("");
    let action = "";
    if (record.status === "待返工") action = reworkForm();
    else if (record.status === "返工中")
      action = `<div class="qc-rework">返工：${esc(record.rework.reason)} · 耗材批号 ${esc(record.rework.materialLot)} · 新厚度 ${record.rework.thickness}μm · 操作人 ${esc(record.rework.reworker)}</div>` + reviewForm();
    else if (record.status === "已闭环")
      action = `<div class="qc-rework">返工：${esc(record.rework.reason)} · 耗材批号 ${esc(record.rework.materialLot)} · 新厚度 ${record.rework.thickness}μm · 操作人 ${esc(record.rework.reworker)}</div>
        <div class="qc-closed">复核通过：复核人 ${esc(record.review.reviewer)} · ${fmt(record.review.at)}，可继续制片与交付</div>`;
    const banner = ["待返工", "返工中"].includes(record.status)
      ? `<div class="qc-warn">异常片已退出观察与交付（处置单 ${esc(record.id)} · ${esc(record.status)}）</div>` : "";
    const timeline = record.history.map(h => `<div class="qc-hist">${fmt(h.at)} ${esc(h.action)}</div>`).join("");
    return `<div class="qc-case qc-${esc(record.status)}" data-qc-box>
      <div class="qc-title">处置单 ${esc(record.id)} <span class="qc-status">${esc(record.status)}</span></div>
      ${banner}${photos}${action}
      <details class="qc-details"><summary>处置时间线（${record.history.length}）</summary>${timeline}</details>
    </div>`;
  }

  function sliceFixForm(sid, slid) {
    return `<div data-qc-box class="qc-fix">
      <div class="qc-title">切片编号更正（更正后处置立即失效）</div>
      <input name="qc-slice-id" value="${esc(slid)}">
      <button data-qc-fix-slice="${sid}|${slid}">更正切片编号</button>
    </div>`;
  }

  async function mountAll() {
    const samples = window.samples || [];
    let records = [];
    try { records = await window.api("/api/quality-records"); } catch (e) { return; }

    document.querySelectorAll("[data-quality-slice]").forEach(el => {
      const [sid, slid] = el.dataset.qualitySlice.split("|");
      const record = records.find(r => r.sampleId === sid && r.sliceId === slid && r.status !== "已作废");
      el.innerHTML = (record ? casePanel(record, sid, slid) : reportForm(sid, slid)) + sliceFixForm(sid, slid);
    });

    document.querySelectorAll("[data-quality-sample]").forEach(el => {
      const sid = el.dataset.qualitySample;
      const sample = samples.find(s => s.id === sid);
      if (!sample) return;
      const active = records.filter(r => r.sampleId === sid && ["待返工", "返工中"].includes(r.status));
      const detached = records.filter(r => r.sampleId === sid && r.status === "已作废");
      const banner = active.length
        ? `<div class="qc-warn">${active.length} 条异常未闭环（${active.map(r => esc(r.id)).join("、")}），样本暂不能交付</div>` : "";
      const fixBorehole = `<div data-qc-box class="qc-fix">
        <div class="qc-title">钻孔编号更正（更正后相关处置单立即失效）</div>
        <input name="qc-borehole" value="${esc(sample.borehole)}">
        <button data-qc-fix-borehole="${sid}">更正钻孔编号</button>
      </div>`;
      const voidList = detached.map(r =>
        `<div class="qc-void">处置单 ${esc(r.id)}（${esc(r.sliceId)}）因编号更正已作废 · ${fmt(r.history[r.history.length - 1].at)}</div>`).join("");
      el.innerHTML = banner + fixBorehole + voidList;
    });
  }

  async function post(url, body) {
    try {
      await window.api(url, { method: "POST", body: JSON.stringify(body) });
      await window.load();
    } catch (e) { alert(e.message); }
  }

  document.addEventListener("click", async ev => {
    const btn = ev.target.closest("[data-qc-report],[data-qc-rework],[data-qc-review],[data-qc-fix-borehole],[data-qc-fix-slice]");
    if (!btn) return;
    const box = btn.closest("[data-qc-box]");
    const val = name => box.querySelector(`[name="${name}"]`).value.trim();

    if (btn.dataset.qcReport !== undefined) {
      const [sid, slid] = btn.dataset.qcReport.split("|");
      const photo = await readPhoto(box.querySelector('[name="qc-photo"]'));
      await post(`/api/samples/${sid}/slices/${slid}/quality-report`,
        { type: val("qc-type"), thickness: val("qc-thickness"), photo, finder: val("qc-finder") });
    } else if (btn.dataset.qcRework !== undefined) {
      const wrap = btn.closest("[data-qc-box]");
      const root = btn.closest("[data-quality-slice]");
      const [sid, slid] = root.dataset.qualitySlice.split("|");
      await post(`/api/samples/${sid}/slices/${slid}/quality-rework`,
        { reason: val("qc-reason"), materialLot: val("qc-lot"), thickness: val("qc-new-thickness"), reworker: val("qc-reworker") });
    } else if (btn.dataset.qcReview !== undefined) {
      const root = btn.closest("[data-quality-slice]");
      const [sid, slid] = root.dataset.qualitySlice.split("|");
      await post(`/api/samples/${sid}/slices/${slid}/quality-review`, { reviewer: val("qc-reviewer") });
    } else if (btn.dataset.qcFixBorehole !== undefined) {
      await post(`/api/samples/${btn.dataset.qcFixBorehole}/correct-borehole`, { borehole: val("qc-borehole") });
    } else if (btn.dataset.qcFixSlice !== undefined) {
      const [sid, slid] = btn.dataset.qcFixSlice.split("|");
      await post(`/api/samples/${sid}/slices/${slid}/correct-slice-id`, { sliceId: val("qc-slice-id") });
    }
  });

  window.afterRender = mountAll;
  if (document.readyState !== "loading") mountAll();
  else document.addEventListener("DOMContentLoaded", mountAll);
})();
