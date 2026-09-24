// 质量异常处置记录：上报、返工登记、复核、编号更正。
// 与样本数据分开存储于 data/quality-records.json，所有状态变更写入时间线。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASE_STATUS,
  validateReport,
  validateRework,
  validateReview,
  sameCaseIdentity,
  isCaseStale,
  isCaseActive,
} from "./quality-rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const recordsPath = join(__dirname, "data", "quality-records.json");

async function loadStore() {
  if (!existsSync(recordsPath)) {
    await mkdir(dirname(recordsPath), { recursive: true });
    await writeFile(recordsPath, JSON.stringify({ seq: 0, records: [] }, null, 2));
  }
  return JSON.parse(await readFile(recordsPath, "utf8"));
}
async function saveStore(store) {
  await writeFile(recordsPath, JSON.stringify(store, null, 2));
}

const now = () => new Date().toISOString();
const fail = (status, error) => { const e = new Error(error); e.status = status; return e; };
function appendHistory(record, action, detail) {
  record.history.push({ at: now(), action, ...detail });
}
export function listRecords(store) { return store.records; }
export function activeRecords(store) { return store.records.filter(isCaseActive); }

// 定位某切片当前的处置单（同编号）；编号更正后原处置单视为过期，返回 null
export function findCase(store, sample, slice) {
  return store.records.find(r => sameCaseIdentity(r, sample, slice)) || null;
}

// 上报质量异常：重复提交沿用首次编号；编号已被更正的旧处置单不能继续，须重新立单
export async function reportException(store, sample, slice, input) {
  const error = validateReport(input);
  if (error) throw fail(400, error);

  const existing = findCase(store, sample, slice);
  if (existing && isCaseStale(existing, sample, slice))
    throw fail(409, `原处置单 ${existing.id} 因编号更正已作废，请按新编号重新上报`);

  if (existing) {
    // 重复提交沿用首次编号，记录追加到同一处置单；已闭环后再次出现异常则重新打开
    existing.reports.push({
      at: now(),
      type: input.type,
      thickness: Number(input.thickness),
      photo: input.photo,
      finder: String(input.finder).trim(),
    });
    existing.status = CASE_STATUS.OPEN;
    existing.rework = null;
    existing.review = null;
    appendHistory(existing, "重复上报", { type: input.type, thickness: Number(input.thickness), finder: String(input.finder).trim() });
    slice.status = "研磨";
    await saveStore(store);
    return existing;
  }

  store.seq += 1;
  const record = {
    id: `QC-${String(store.seq).padStart(4, "0")}`,
    sampleId: sample.id,
    project: sample.project,
    borehole: sample.borehole, // 首次编号快照：钻孔编号
    sliceId: slice.id,         // 首次编号快照：切片编号
    status: CASE_STATUS.OPEN,
    reports: [{
      at: now(),
      type: input.type,
      thickness: Number(input.thickness),
      photo: input.photo,
      finder: String(input.finder).trim(),
    }],
    rework: null,
    review: null,
    history: [],
  };
  appendHistory(record, "上报异常", { type: input.type, thickness: Number(input.thickness), finder: String(input.finder).trim() });
  store.records.push(record);

  // 异常片直接改回研磨，退出观察与交付
  slice.status = "研磨";
  await saveStore(store);
  return record;
}

// 返工登记：填写原因、耗材批号、新厚度（25~35μm）和返工操作人
export async function submitRework(store, sample, slice, input) {
  const record = findCase(store, sample, slice);
  if (!record) throw fail(404, "该切片没有质量异常处置单");
  if (isCaseStale(record, sample, slice)) throw fail(409, `处置单 ${record.id} 因编号更正已作废`);
  if (record.status === CASE_STATUS.CLOSED) throw fail(409, "该处置单已闭环");

  const error = validateRework(input);
  if (error) throw fail(400, error);

  record.rework = {
    at: now(),
    reason: String(input.reason).trim(),
    materialLot: String(input.materialLot).trim(),
    thickness: Number(input.thickness),
    reworker: String(input.reworker).trim(),
  };
  record.status = CASE_STATUS.REWORKING;
  appendHistory(record, "返工登记", record.rework);
  slice.status = "研磨";
  await saveStore(store);
  return record;
}

// 另一人复核：复核人与返工操作人不同，通过后才能继续后续步骤
export async function reviewRework(store, sample, slice, input) {
  const record = findCase(store, sample, slice);
  if (!record) throw fail(404, "该切片没有质量异常处置单");
  if (isCaseStale(record, sample, slice)) throw fail(409, `处置单 ${record.id} 因编号更正已作废`);
  if (!record.rework) throw fail(409, "尚未登记返工，不能复核");

  const error = validateReview(input, record);
  if (error) throw fail(400, error);

  record.review = { at: now(), reviewer: String(input.reviewer).trim(), result: "通过" };
  record.status = CASE_STATUS.CLOSED;
  appendHistory(record, "复核通过", record.review);
  await saveStore(store);
  return record;
}

// 钻孔编号更正：该样本下全部处置单立即作废，处置随之失效
export async function correctBorehole(store, sample, newBoreholeRaw) {
  const newBorehole = String(newBoreholeRaw || "").trim();
  if (!newBorehole) throw fail(400, "钻孔编号不能为空");
  if (newBorehole === sample.borehole) throw fail(400, "钻孔编号没有变化");

  const before = sample.borehole;
  const tied = store.records.filter(r => r.sampleId === sample.id && r.borehole === before);
  sample.borehole = newBorehole;
  for (const record of tied) {
    if (record.status === CASE_STATUS.VOID) continue;
    record.status = CASE_STATUS.VOID;
    appendHistory(record, "钻孔编号更正作废", { before, after: newBorehole });
  }
  await saveStore(store);
  return tied.map(r => r.id);
}

// 切片编号更正：该切片的处置单立即作废
export async function correctSliceId(store, sample, slice, newSliceIdRaw) {
  const newSliceId = String(newSliceIdRaw || "").trim();
  if (!newSliceId) throw fail(400, "切片编号不能为空");
  if (newSliceId === slice.id) throw fail(400, "切片编号没有变化");
  if (sample.slices.some(s => s !== slice && s.id === newSliceId))
    throw fail(409, `切片编号 ${newSliceId} 已存在`);

  const before = slice.id;
  const record = findCase(store, sample, slice); // 必须在改号前定位
  slice.id = newSliceId;
  if (record && record.status !== CASE_STATUS.VOID) {
    record.status = CASE_STATUS.VOID;
    appendHistory(record, "切片编号更正作废", { before, after: newSliceId });
    await saveStore(store);
  }
  return record ? record.id : null;
}

export { loadStore, saveStore };
