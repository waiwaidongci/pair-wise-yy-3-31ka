// 质量异常处置规则判断（纯函数，不读写任何记录）
// 异常类型：空片、连片、厚度偏差；返工后厚度须回到 25~35μm，并由非返工人员复核。

export const EXCEPTION_TYPES = ["空片", "连片", "厚度偏差"];

export const THICKNESS = { MIN: 25, MAX: 35 }; // 微米，合格区间

// 处置状态机：待返工 -> 返工中 -> 已闭环；编号更正后 已作废
export const CASE_STATUS = {
  OPEN: "待返工",
  REWORKING: "返工中",
  CLOSED: "已闭环",
  VOID: "已作废",
};

// 异常片退出的步骤：观察与交付
export const BLOCKED_STEPS = ["观察", "交付"];

const identityOf = (sample, slice) => ({ borehole: sample.borehole, sliceId: slice.id });

// 异常上报是否合规
export function validateReport(input) {
  if (!EXCEPTION_TYPES.includes(input.type)) return "异常类型必须是 空片 / 连片 / 厚度偏差";
  const thickness = Number(input.thickness);
  if (!Number.isFinite(thickness)) return "实测厚度必须是数字（微米）";
  if (thickness <= 0) return "实测厚度必须大于 0";
  if (input.type === "厚度偏差" && thickness >= THICKNESS.MIN && thickness <= THICKNESS.MAX)
    return `厚度 ${thickness}μm 在 ${THICKNESS.MIN}~${THICKNESS.MAX}μm 合格区间内，不构成厚度偏差`;
  if (!input.photo) return "必须上传异常片照片";
  if (!String(input.finder || "").trim()) return "必须填写发现人";
  return null;
}

// 返工登记是否合规：需填写返工原因与耗材批号，且新厚度回到 25~35μm
export function validateRework(input) {
  if (!String(input.reason || "").trim()) return "必须填写返工原因";
  if (!String(input.materialLot || "").trim()) return "必须填写耗材批号";
  const thickness = Number(input.thickness);
  if (!Number.isFinite(thickness)) return "返工后新厚度必须是数字（微米）";
  if (thickness < THICKNESS.MIN || thickness > THICKNESS.MAX)
    return `返工后新厚度 ${thickness}μm 未回到 ${THICKNESS.MIN}~${THICKNESS.MAX}μm，不能提交返工`;
  if (!String(input.reworker || "").trim()) return "必须填写返工操作人";
  return null;
}

// 复核是否合规：复核人必须与返工操作人不是同一人
export function validateReview(input, record) {
  if (!String(input.reviewer || "").trim()) return "必须填写复核人";
  if (record.rework && input.reviewer.trim() === record.rework.reworker)
    return "复核人不能与返工操作人为同一人";
  return null;
}

// 重复提交沿用首次编号：同一样本+同一钻孔编号+同一切片编号视为同一条处置
export function sameCaseIdentity(record, sample, slice) {
  const id = identityOf(sample, slice);
  return record.sampleId === sample.id &&
    record.borehole === id.borehole &&
    record.sliceId === id.sliceId;
}

// 钻孔或切片编号更正 -> 首次编号对应的处置失效
export function isCaseStale(record, sample, slice) {
  const id = identityOf(sample, slice);
  return record.borehole !== id.borehole || record.sliceId !== id.sliceId;
}

// 处置是否仍未闭环（作废记录不再起约束作用）
export function isCaseActive(record) {
  return record && record.status !== CASE_STATUS.CLOSED && record.status !== CASE_STATUS.VOID;
}

// 异常片退出观察与交付：有待返工/返工中（含复核未过）的处置时拦截
export function blockedStepReason(record, step) {
  if (!isCaseActive(record)) return null;
  if (!BLOCKED_STEPS.includes(step)) return null;
  return `质量异常未闭环（处置单 ${record.id}，状态：${record.status}），异常片已退出${step}`;
}

// 整个样本不能交付：任一切片存在未闭环异常
export function blockedDeliveryReason(activeRecords, sampleId) {
  const open = activeRecords.filter(r => r.sampleId === sampleId);
  if (open.length)
    return `存在 ${open.length} 条未闭环的质量异常处置（${open.map(r => r.id).join("、")}），不能交付`;
  return null;
}
