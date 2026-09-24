// 质量异常处置记录：报告异常、返工登记、复核放行、编号更正失效
// 记录挂在 db.quality 上；切片上保留 slice.quality.blocked 供车间判断当前状态。

import {
  REWORK_STEP,
  validateException,
  validateRework,
  reviewBlockers
} from "./quality-rules.js";

const STATES = ["处置中", "已闭环", "已失效"];

export function initQuality(db) {
  if (!Array.isArray(db.quality)) db.quality = [];
}

function nextQcId(db) {
  let max = 0;
  for (const record of db.quality) {
    const n = parseInt(String(record.id).replace(/^QC-/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `QC-${String(max + 1).padStart(3, "0")}`;
}

function findSample(db, sampleId) {
  return db.samples.find(item => item.id === sampleId) || null;
}

function findSlice(sample, sliceId) {
  return sample ? sample.slices.find(item => item.id === sliceId) || null : null;
}

// 重复提交沿用首次编号：返回该切片当前仍有效的处置单（处置中优先，其次已闭环）
function findActiveRecord(db, sampleId, sliceId) {
  const matches = db.quality.filter(
    r => r.sampleId === sampleId && r.sliceId === sliceId && r.state !== "已失效"
  );
  return matches.find(r => r.state === "处置中") || matches[0] || null;
}

function setBlocked(slice, record) {
  slice.quality = { qcId: record.id, blocked: true };
  slice.status = REWORK_STEP;
}

function clearBlocked(slice) {
  if (slice.quality) slice.quality.blocked = false;
}

function log(slice, note) {
  slice.logs.push({ at: new Date().toISOString(), step: "质量", note });
}

// 报告质量异常（同一有效处置单内重复报告沿用首次编号）
export function reportException(db, sampleId, sliceId, input = {}) {
  const sample = findSample(db, sampleId);
  const slice = findSlice(sample, sliceId);
  if (!slice) return { status: 404, error: "slice_not_found" };

  const { errors, value } = validateException(input);
  if (Object.keys(errors).length) return { status: 400, error: "invalid_exception", details: errors };

  let record = findActiveRecord(db, sampleId, sliceId);
  let reused = false;
  if (!record) {
    record = {
      id: nextQcId(db),
      sampleId,
      sliceId,
      borehole: sample.borehole,
      state: "处置中",
      reports: [],
      reworks: [],
      review: null,
      createdAt: new Date().toISOString()
    };
    db.quality.push(record);
  } else if (record.state === "已闭环") {
    // 闭环后再次发现异常：沿用首次编号重新开启处置
    record.state = "处置中";
    record.review = null;
    reused = true;
  } else {
    reused = true;
  }
  record.borehole = sample.borehole;

  record.reports.push({
    at: new Date().toISOString(),
    type: value.type,
    thickness: value.thickness,
    photos: value.photos,
    finder: value.finder
  });

  // 异常片退出观察与交付，直接改回研磨
  setBlocked(slice, record);
  log(
    slice,
    `报告异常${reused ? "（重复提交，沿用编号 " + record.id + "）" : ""}：${value.type}，实测 ${value.thickness}μm，发现人 ${value.finder}，退回${REWORK_STEP}`
  );

  return { status: 200, record, slice };
}

// 返工登记：原因、耗材批号、新厚度（区间校验在规则层完成）
export function submitRework(db, sampleId, sliceId, input = {}) {
  const sample = findSample(db, sampleId);
  const slice = findSlice(sample, sliceId);
  if (!slice) return { status: 404, error: "slice_not_found" };

  const record = findActiveRecord(db, sampleId, sliceId);
  if (!record || record.state !== "处置中") {
    return { status: 409, error: "no_open_disposition", message: "该切片没有处置中的异常单，无法登记返工" };
  }

  const { errors, value } = validateRework(input);
  if (Object.keys(errors).length) return { status: 400, error: "invalid_rework", details: errors };

  record.reworks.push({
    at: new Date().toISOString(),
    reason: value.reason,
    materialLot: value.materialLot,
    newThickness: value.newThickness,
    operator: value.operator || ""
  });
  // 返工后仍需另一人复核，封锁状态保持
  slice.status = REWORK_STEP;
  log(slice, `登记返工：${value.reason}，耗材批号 ${value.materialLot}，新厚度 ${value.newThickness}μm，待另一人复核`);

  return { status: 200, record, slice };
}

// 另一人复核：合格才解除封锁，允许继续
export function review(db, sampleId, sliceId, input = {}) {
  const sample = findSample(db, sampleId);
  const slice = findSlice(sample, sliceId);
  if (!slice) return { status: 404, error: "slice_not_found" };

  const record = findActiveRecord(db, sampleId, sliceId);
  const reviewer = String(input.reviewer || "").trim();
  const blockers = reviewBlockers(record, reviewer);
  if (blockers.length) return { status: 400, error: "review_not_allowed", details: blockers };

  const latestRework = record.reworks[record.reworks.length - 1];
  record.review = {
    at: new Date().toISOString(),
    reviewer,
    newThickness: latestRework.newThickness,
    result: "合格"
  };
  record.state = "已闭环";
  clearBlocked(slice);
  log(slice, `复核合格：复核人 ${reviewer}，确认厚度 ${latestRework.newThickness}μm，解除封锁可继续`);

  return { status: 200, record, slice };
}

// 处置单失效的公共处理：编号更正（钻孔或切片编号）会让处置失效
function invalidate(record, slice, reason) {
  record.state = "已失效";
  record.invalidatedAt = new Date().toISOString();
  record.invalidateReason = reason;
  clearBlocked(slice);
  log(slice, `处置单 ${record.id} 失效：${reason}`);
}

// 更正钻孔编号：该样本下所有处置中的异常单全部失效
export function correctBorehole(db, sampleId, borehole) {
  const sample = findSample(db, sampleId);
  if (!sample) return { status: 404, error: "sample_not_found" };

  const next = String(borehole || "").trim();
  if (!next) return { status: 400, error: "invalid_borehole", details: { borehole: "钻孔编号不能为空" } };

  const previous = sample.borehole;
  if (previous === next) return { status: 200, sample, invalidated: [], unchanged: true };
  sample.borehole = next;
  const invalidated = [];
  for (const slice of sample.slices) {
    for (const record of db.quality) {
      if (
        record.sampleId === sampleId &&
        record.sliceId === slice.id &&
        record.state === "处置中"
      ) {
        invalidate(record, slice, `钻孔编号由 ${previous} 更正为 ${next}`);
        invalidated.push(record.id);
      }
    }
  }
  return { status: 200, sample, invalidated };
}

// 更正切片编号：该切片处置中的异常单失效
export function correctSliceId(db, sampleId, oldSliceId, nextSliceId) {
  const sample = findSample(db, sampleId);
  const slice = findSlice(sample, oldSliceId);
  if (!slice) return { status: 404, error: "slice_not_found" };

  const next = String(nextSliceId || "").trim();
  if (!next) return { status: 400, error: "invalid_slice_id", details: { sliceId: "切片编号不能为空" } };
  if (sample.slices.some(item => item !== slice && item.id === next)) {
    return { status: 409, error: "slice_id_exists", message: "切片编号已存在" };
  }

  const previous = slice.id;
  if (previous === next) return { status: 200, sample, invalidated: [], unchanged: true };
  slice.id = next;
  const invalidated = [];
  for (const record of db.quality) {
    if (
      record.sampleId === sampleId &&
      record.sliceId === previous &&
      record.state === "处置中"
    ) {
      invalidate(record, slice, `切片编号由 ${previous} 更正为 ${next}`);
      invalidated.push(record.id);
    }
  }
  return { status: 200, sample, invalidated };
}

export function listRecords(db) {
  return [...db.quality].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export { STATES };
