// 质量异常规则判断：异常类型、厚度区间、复核资格、流程封锁与处置失效
// 纯函数，不读写数据库，便于单独核对规则。

export const EXCEPTION_TYPES = ["空片", "连片", "厚度偏差"];

// 合格薄片厚度区间（微米），返工后必须回到该区间
export const THICKNESS_MIN = 25;
export const THICKNESS_MAX = 35;

// 出现异常后直接退回的工序
export const REWORK_STEP = "研磨";

// 异常处置未闭环前禁止继续的工序
const BLOCKED_STEPS = ["染色", "观察"];

export function parseThickness(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function thicknessInRange(thickness) {
  return thickness >= THICKNESS_MIN && thickness <= THICKNESS_MAX;
}

// 照片支持数组，或逗号/空白分隔的字符串（文件名或链接）
export function normalizePhotos(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  return [];
}

// 异常上报校验：异常类型、实测厚度、照片、发现人
export function validateException(input = {}) {
  const errors = {};
  const type = String(input.type || "").trim();
  if (!EXCEPTION_TYPES.includes(type)) {
    errors.type = "异常类型必须是：空片、连片、厚度偏差";
  }

  const thickness = parseThickness(input.thickness);
  if (thickness === null) {
    errors.thickness = "实测厚度必须是不小于 0 的数字（微米）";
  } else if (type === "厚度偏差" && thicknessInRange(thickness)) {
    errors.thickness = `实测 ${thickness}μm 仍在 ${THICKNESS_MIN}-${THICKNESS_MAX}μm 区间内，不构成厚度偏差`;
  }

  const photos = normalizePhotos(input.photos);
  if (!photos.length) errors.photos = "至少保留一张异常照片（文件名或链接）";

  const finder = String(input.finder || "").trim();
  if (!finder) errors.finder = "发现人不能为空";

  return { errors, value: { type, thickness, photos, finder } };
}

// 返工登记校验：返工原因、耗材批号、新厚度（25-35μm）
export function validateRework(input = {}) {
  const errors = {};
  const reason = String(input.reason || "").trim();
  if (!reason) errors.reason = "返工原因不能为空";

  const materialLot = String(input.materialLot || "").trim();
  if (!materialLot) errors.materialLot = "耗材批号不能为空";

  const newThickness = parseThickness(input.newThickness);
  if (newThickness === null) {
    errors.newThickness = "新厚度必须是数字（微米）";
  } else if (!thicknessInRange(newThickness)) {
    errors.newThickness = `返工后厚度必须回到 ${THICKNESS_MIN}-${THICKNESS_MAX}μm，当前实测 ${newThickness}μm`;
  }

  const operator = String(input.operator || "").trim();
  return { errors, value: { reason, materialLot, newThickness, operator } };
}

// 复核资格判断：必须有返工、厚度在区间内，且复核人是发现人/返工操作人之外的另一人
export function reviewBlockers(record, reviewerInput) {
  const blockers = [];
  const reviewer = String(reviewerInput || "").trim();
  if (!reviewer) blockers.push("复核人不能为空");
  if (!record) {
    blockers.push("没有进行中的质量处置单");
    return blockers;
  }
  if (record.state === "已失效") blockers.push("处置单已随编号更正失效，需重新报告异常");
  if (!record.reworks.length) blockers.push("尚未登记返工，不能复核");

  const latestReport = record.reports[record.reports.length - 1];
  const latestRework = record.reworks[record.reworks.length - 1];
  // 重新发现异常（沿用编号重开）后，必须重新登记返工
  if (latestReport && latestRework && latestRework.at < latestReport.at) {
    blockers.push("最近一次异常报告之后尚未重新登记返工");
  }
  if (latestRework && !thicknessInRange(latestRework.newThickness)) {
    blockers.push(`最近一次返工厚度 ${latestRework.newThickness}μm 未回到 ${THICKNESS_MIN}-${THICKNESS_MAX}μm`);
  }
  if (reviewer) {
    if (latestReport && latestReport.finder === reviewer) {
      blockers.push("复核人必须是发现人之外的另一人");
    }
    if (latestRework && latestRework.operator && latestRework.operator === reviewer) {
      blockers.push("复核人不能是本次返工操作人，必须由另一人复核");
    }
  }
  return blockers;
}

export function isForwardStep(step) {
  return BLOCKED_STEPS.includes(step);
}

// 异常片退出观察与交付：切片上存在未闭环处置时封锁
export function isBlockedSlice(slice) {
  return !!(slice && slice.quality && slice.quality.blocked);
}
