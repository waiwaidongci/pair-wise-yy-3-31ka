// 质量异常的页面操作：异常上报、返工登记、复核、编号更正的接口与前端面板。

import { EXCEPTION_TYPES, THICKNESS_MIN, THICKNESS_MAX } from "./quality-rules.js";
import {
  reportException,
  submitRework,
  review,
  correctBorehole,
  correctSliceId,
  listRecords
} from "./quality-records.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// 命中质量相关路由时返回 true
export async function handleQualityRoute(req, res, url, db) {
  const match = (pattern, method) => {
    const found = url.pathname.match(pattern);
    return found && req.method === method ? found.slice(1) : null;
  };

  if (req.method === "GET" && url.pathname === "/api/quality/records") {
    send(res, 200, listRecords(db));
    return true;
  }

  let m;
  if ((m = match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/quality\/exception$/, "POST"))) {
    const out = reportException(db, m[0], m[1], await readBody(req));
    send(res, out.status, out);
    return true;
  }
  if ((m = match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/quality\/rework$/, "POST"))) {
    const out = submitRework(db, m[0], m[1], await readBody(req));
    send(res, out.status, out);
    return true;
  }
  if ((m = match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/quality\/review$/, "POST"))) {
    const out = review(db, m[0], m[1], await readBody(req));
    send(res, out.status, out);
    return true;
  }
  if ((m = match(/^\/api\/samples\/([^/]+)\/borehole$/, "PATCH"))) {
    const input = await readBody(req);
    const out = correctBorehole(db, m[0], input.borehole);
    send(res, out.status, out);
    return true;
  }
  if ((m = match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/id$/, "PATCH"))) {
    const input = await readBody(req);
    const out = correctSliceId(db, m[0], m[1], input.sliceId);
    send(res, out.status, out);
    return true;
  }
  return false;
}

export const qualityStyles = `
  .qc { border:1px solid var(--line); border-radius:6px; margin-top:10px; padding:10px; background:#f7f8f4; }
  .qc.open { border-color:#c0392b; background:#fdf3f1; }
  .qc.closed { border-color:#526f43; background:#f3f7ef; }
  .qc.invalid { border-color:var(--stone); background:#f2f1ee; }
  .qc-badge { display:inline-block; border-radius:999px; padding:2px 9px; font-size:12px; font-weight:700; color:#fff; background:#c0392b; margin-left:6px; }
  .qc-badge.closed { background:#526f43; } .qc-badge.invalid { background:var(--stone); }
  .qc-blocked, .qc-flag { color:#c0392b; font-size:12px; font-weight:700; }
  .qc-row { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-top:8px; }
  .qc-row label { margin:0; flex:1 1 130px; }
  .qc-btn { padding:7px 10px; font-size:12px; }
  .qc-btn.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .qc ul { margin:6px 0 0; padding-left:18px; font-size:12px; color:var(--muted); }
  .qc li { margin:2px 0; }
  .qc-board { margin-top:22px; }
  .qc-record { border:1px solid var(--line); border-left-width:4px; border-radius:6px; background:#fff; padding:10px 12px; margin-bottom:8px; font-size:13px; }
  .qc-record.state-open { border-left-color:#c0392b; }
  .qc-record.state-closed { border-left-color:#526f43; }
  .qc-record.state-invalid { border-left-color:var(--stone); }
`;


export const qualityScript = `
<script>
(function () {
  var exceptionTypes = ${JSON.stringify(EXCEPTION_TYPES)};
  var rangeText = ${JSON.stringify(THICKNESS_MIN + "-" + THICKNESS_MAX + "μm")};
  var tMin = ${THICKNESS_MIN}, tMax = ${THICKNESS_MAX};
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c];
    });
  };
  var fmt = function (at) {
    try { return new Date(at).toLocaleString("zh-CN", { hour12:false }); } catch (e) { return at; }
  };
  var photosHtml = function (list) {
    return list.map(function (p) { return "<span class=\\"pill\\">📷 " + esc(p) + "</span>"; }).join(" ");
  };
  var fld = function (sampleId, sliceId, name) {
    return document.querySelector("[data-qc-field=\\"" + sampleId + "|" + sliceId + "|" + name + "\\"]");
  };
  var attr = function (name, value) { return " " + name + "=\\"" + value + "\\""; };

  function call(path, method, body) {
    return fetch(path, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var detail = data.details
              ? (Array.isArray(data.details) ? data.details.join("；") : Object.keys(data.details).map(function (k) { return data.details[k]; }).join("；"))
              : (data.message || "操作失败");
            throw new Error(detail);
          }
          return data;
        });
      });
  }

  // 报告异常表单：异常类型、实测厚度、照片、发现人
  function reportForm(sampleId, sliceId) {
    var k = sampleId + "|" + sliceId + "|";
    return "<div class=\\"qc-row\\">"
      + "<label>异常类型<select" + attr("data-qc-field", k + "type") + ">"
      + exceptionTypes.map(function (t) { return "<option>" + t + "</option>"; }).join("") + "</select></label>"
      + "<label>实测厚度μm<input type=\\"number\\" min=\\"0\\" step=\\"0.1\\"" + attr("data-qc-field", k + "thickness") + "></label>"
      + "<label>照片（文件名或链接，多个用逗号分隔）<input" + attr("data-qc-field", k + "photos") + "></label>"
      + "<label>发现人<input" + attr("data-qc-field", k + "finder") + "></label>"
      + "<button class=\\"qc-btn\\"" + attr("data-qc-report", sampleId + "|" + sliceId) + ">报告异常并退回研磨</button></div>";
  }

  function panelHtml(sampleId, record, invalid) {
    if (record && record.state === "处置中") {
      var k = sampleId + "|" + record.sliceId + "|";
      var html = "<div class=\\"qc open\\"><div><b>处置中 " + esc(record.id) + "</b> <span class=\\"qc-blocked\\">异常片：已退出观察与交付</span></div><ul>"
        + record.reports.map(function (r) {
            return "<li>" + fmt(r.at) + " 报告 " + esc(r.type) + "，实测 " + esc(r.thickness) + "μm，发现人 " + esc(r.finder) + " " + photosHtml(r.photos) + "</li>";
          }).join("")
        + record.reworks.map(function (r) {
            return "<li>" + fmt(r.at) + " 返工：" + esc(r.reason) + "，耗材批号 " + esc(r.materialLot) + "，新厚度 " + esc(r.newThickness) + "μm" + (r.operator ? "，操作人 " + esc(r.operator) : "") + "</li>";
          }).join("") + "</ul>";
      html += "<div class=\\"qc-row\\">"
        + "<label>返工原因<input" + attr("data-qc-field", k + "reason") + "></label>"
        + "<label>耗材批号<input" + attr("data-qc-field", k + "materialLot") + "></label>"
        + "<label>返工后新厚度μm（" + rangeText + "）<input type=\\"number\\" min=\\"" + tMin + "\\" max=\\"" + tMax + "\\" step=\\"0.1\\"" + attr("data-qc-field", k + "newThickness") + "></label>"
        + "<label>返工操作人（可选）<input" + attr("data-qc-field", k + "operator") + "></label>"
        + "<button class=\\"qc-btn\\"" + attr("data-qc-rework", sampleId + "|" + record.sliceId) + ">登记返工</button></div>";
      html += "<div class=\\"qc-row\\"><label>复核人（须为发现人/返工操作人之外的另一人）<input" + attr("data-qc-field", k + "reviewer") + "></label>"
        + "<button class=\\"qc-btn\\"" + attr("data-qc-review", sampleId + "|" + record.sliceId) + ">复核合格，解除封锁</button></div>";
      html += "<div class=\\"qc-blocked\\">另一人复核且厚度在 " + rangeText + " 前，只能停留在研磨，不能进入染色/观察或交付</div></div>";
      return html;
    }
    if (record && record.state === "已闭环") {
      var rv = record.review || {};
      return "<div class=\\"qc closed\\"><div><b>已闭环 " + esc(record.id) + "</b><span class=\\"qc-badge closed\\">复核合格</span></div><ul>"
        + "<li>最近异常：" + esc(record.reports[record.reports.length - 1].type) + "</li>"
        + "<li>复核人 " + esc(rv.reviewer) + " 于 " + fmt(rv.at) + " 确认厚度 " + esc(rv.newThickness) + "μm（" + rangeText + "）</li></ul>"
        + "<button class=\\"qc-btn ghost\\"" + attr("data-qc-again", sampleId + "|" + record.sliceId) + ">再次发现异常（沿用 " + esc(record.id) + "）</button></div>"
        + "<div class=\\"qc\\"><div class=\\"meta\\">新的异常报告（重复提交沿用编号 " + esc(record.id) + "）</div>" + reportForm(sampleId, record.sliceId) + "</div>";
    }
    if (invalid) {
      return "<div class=\\"qc invalid\\"><div><b>" + esc(invalid.id) + " 已失效</b><span class=\\"qc-badge invalid\\">编号更正</span></div>"
        + "<div class=\\"meta\\">" + esc(invalid.invalidateReason || "编号更正") + "，该处置单不再继续，需重新报告异常</div>"
        + reportForm(sampleId, invalid.sliceId) + "</div>";
    }
    return "";
  }

  function paintSlice(card, sample, slice, records) {
    var sliceEl = card.querySelector("[data-slice-id=\\"" + slice.id + "\\"]");
    if (!sliceEl) return;
    var host = sliceEl.querySelector("[data-qc-host]");
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-qc-host", slice.id);
      sliceEl.appendChild(host);

      var idFix = document.createElement("div");
      idFix.className = "qc-row";
      idFix.innerHTML = "<label>更正切片编号（将使处置失效）<input" + attr("data-sliceid-input", sample.id + "|" + slice.id)
        + " value=\\"" + esc(slice.id) + "\\"></label>"
        + "<button class=\\"qc-btn ghost\\"" + attr("data-fix-slice", sample.id + "|" + slice.id) + ">保存切片编号</button>";
      sliceEl.appendChild(idFix);
    }
    var mine = records.filter(function (r) { return r.sampleId === sample.id && r.sliceId === slice.id; });
    var active = mine.filter(function (r) { return r.state !== "已失效"; }).reverse()[0] || null;
    var invalid = mine.filter(function (r) { return r.state === "已失效"; }).reverse()[0] || null;
    var html;
    if (active) html = panelHtml(sample.id, active, null);
    else if (invalid) html = panelHtml(sample.id, null, invalid);
    else html = "<div class=\\"qc\\"><div class=\\"meta\\">无进行中的质量异常</div>" + reportForm(sample.id, slice.id) + "</div>";
    host.innerHTML = html;
  }

  function paintCard(card, sample, records) {
    if (!card.querySelector("[data-borehole-fix]")) {
      var fix = document.createElement("div");
      fix.className = "qc-row";
      fix.setAttribute("data-borehole-fix", sample.id);
      fix.innerHTML = "<label>更正钻孔编号（将使处置失效）<input" + attr("data-borehole-input", sample.id)
        + " value=\\"" + esc(sample.borehole) + "\\"></label>"
        + "<button class=\\"qc-btn ghost\\"" + attr("data-fix-borehole", sample.id) + ">保存钻孔编号</button>";
      card.appendChild(fix);
    }
    sample.slices.forEach(function (slice) { paintSlice(card, sample, slice, records); });
  }

  function stateClass(state) {
    return state === "处置中" ? "state-open" : state === "已闭环" ? "state-closed" : "state-invalid";
  }

  function paintBoard(records) {
    var board = document.querySelector("#qcBoard");
    if (!board) {
      board = document.createElement("section");
      board.id = "qcBoard";
      board.className = "qc-board";
      document.querySelector("main").appendChild(board);
    }
    if (!records.length) { board.innerHTML = ""; return; }
    var byId = {};
    samples.forEach(function (s) { byId[s.id] = s; });
    board.innerHTML = "<h2>质量异常处置记录（车间可见返工结果）</h2>" + records.map(function (r) {
      var sample = byId[r.sampleId];
      var currentBorehole = sample ? sample.borehole : "（样本已不存在）";
      var reviewLine = r.review
        ? "<li>" + fmt(r.review.at) + " 复核合格：复核人 " + esc(r.review.reviewer) + "，确认 " + esc(r.review.newThickness) + "μm</li>"
        : "<li class=\\"qc-blocked\\">待另一人复核（厚度须回到 " + rangeText + "）</li>";
      var boreholeLine = ' <span class="meta">钻孔：' + esc(currentBorehole)
        + (r.borehole && r.borehole !== currentBorehole ? "（处置时 " + esc(r.borehole) + "）" : "") + "</span>";
      return "<div class=\\"qc-record " + stateClass(r.state) + "\\"><b>" + esc(r.id) + "</b> "
        + "<span class=\\"pill\\">" + esc(r.state) + "</span> "
        + esc(r.sampleId) + " / 切片 " + esc(r.sliceId) + boreholeLine + "<ul>"
        + r.reports.map(function (x) { return "<li>" + fmt(x.at) + " 异常：" + esc(x.type) + "，实测 " + esc(x.thickness) + "μm，照片 " + photosHtml(x.photos) + "，发现人 " + esc(x.finder) + "</li>"; }).join("")
        + r.reworks.map(function (x) { return "<li>" + fmt(x.at) + " 返工：原因 " + esc(x.reason) + "，耗材批号 " + esc(x.materialLot) + "，新厚度 " + esc(x.newThickness) + "μm" + (x.operator ? "，操作人 " + esc(x.operator) : "") + "</li>"; }).join("")
        + reviewLine
        + (r.invalidatedAt ? "<li>" + fmt(r.invalidatedAt) + " 失效：" + esc(r.invalidateReason || "编号更正") + "</li>" : "")
        + "</ul></div>";
    }).join("");
  }

  function paintAll() {
    api("/api/quality/records").then(function (records) {
      document.querySelectorAll(".card[data-sample-id]").forEach(function (card) {
        var sample = samples.find(function (s) { return s.id === card.getAttribute("data-sample-id"); });
        if (sample) paintCard(card, sample, records);
      });
      paintBoard(records);
    }).catch(function () {});
  }

  document.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-qc-report],[data-qc-again],[data-qc-rework],[data-qc-review],[data-fix-borehole],[data-fix-slice]");
    if (!btn) return;
    var key, sampleId, sliceId;
    Promise.resolve().then(function () {
      if (btn.hasAttribute("data-qc-report") || btn.hasAttribute("data-qc-again")) {
        key = (btn.getAttribute("data-qc-report") || btn.getAttribute("data-qc-again")).split("|");
        sampleId = key[0]; sliceId = key[1];
        return call("/api/samples/" + sampleId + "/slices/" + sliceId + "/quality/exception", "POST", {
          type: fld(sampleId, sliceId, "type").value,
          thickness: fld(sampleId, sliceId, "thickness").value,
          photos: fld(sampleId, sliceId, "photos").value,
          finder: fld(sampleId, sliceId, "finder").value
        });
      }
      if (btn.hasAttribute("data-qc-rework")) {
        key = btn.getAttribute("data-qc-rework").split("|"); sampleId = key[0]; sliceId = key[1];
        return call("/api/samples/" + sampleId + "/slices/" + sliceId + "/quality/rework", "POST", {
          reason: fld(sampleId, sliceId, "reason").value,
          materialLot: fld(sampleId, sliceId, "materialLot").value,
          newThickness: fld(sampleId, sliceId, "newThickness").value,
          operator: fld(sampleId, sliceId, "operator").value
        });
      }
      if (btn.hasAttribute("data-qc-review")) {
        key = btn.getAttribute("data-qc-review").split("|"); sampleId = key[0]; sliceId = key[1];
        return call("/api/samples/" + sampleId + "/slices/" + sliceId + "/quality/review", "POST", {
          reviewer: fld(sampleId, sliceId, "reviewer").value
        });
      }
      if (btn.hasAttribute("data-fix-borehole")) {
        sampleId = btn.getAttribute("data-fix-borehole");
        var input = document.querySelector("[data-borehole-input=\\"" + sampleId + "\\"]");
        if (!confirm("更正钻孔编号会让该样本所有处置中的异常单失效，确定继续？")) return null;
        return call("/api/samples/" + sampleId + "/borehole", "PATCH", { borehole: input.value });
      }
      key = btn.getAttribute("data-fix-slice").split("|"); sampleId = key[0]; sliceId = key[1];
      var sinput = document.querySelector("[data-sliceid-input=\\"" + sampleId + "|" + sliceId + "\\"]");
      if (!confirm("更正切片编号会让该异常处置失效，确定继续？")) return null;
      return call("/api/samples/" + sampleId + "/slices/" + sliceId + "/id", "PATCH", { sliceId: sinput.value });
    }).then(function (done) {
      if (done) return load();
    }).catch(function (e) { alert(e.message); });
  });

  var scheduled = false;
  new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; paintAll(); });
  }).observe(document.querySelector("#samples"), { childList: true });
  setTimeout(paintAll, 200);
})();
</script>`;
