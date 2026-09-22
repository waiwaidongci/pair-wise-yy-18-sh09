// 借展放行判定层：纯业务规则，不碰 HTTP 与数据库。
// 覆盖：借展单门禁（温湿度/保险/封条）、档期重叠、归还复核、更正重算。

const STATUS = {
  PENDING: '待检',
  RELEASED: '已放行',
  ON_LOAN: '出借中',
  RETURNED: '已归还',
  RETURNED_ABNORMAL: '归还异常'
};

// 仍占用档期的状态：待检不占档期，归还类终态释放档期
const OCCUPYING_STATUSES = [STATUS.RELEASED, STATUS.ON_LOAN];

const TEMP_MIN = 15;
const TEMP_MAX = 30;
const HUMIDITY_MAX = 65;

// 出借前必须登记的运输环境与交接信息
const REQUIRED_FIELDS = [
  'headIds',
  'venue',
  'loanStart',
  'loanEnd',
  'boxNo',
  'temperature',
  'humidity',
  'bufferBatch',
  'insuranceNo',
  'insuranceExpiry',
  'sealNo',
  'handler'
];

// 更正时允许修改的字段；档期、箱体、保险三类改动会让放行失效重算
const EDITABLE_FIELDS = [
  'venue',
  'loanStart',
  'loanEnd',
  'boxNo',
  'temperature',
  'humidity',
  'bufferBatch',
  'insuranceNo',
  'insuranceExpiry',
  'sealNo',
  'handler',
  'note'
];

const RELEASING_FIELDS = [
  'loanStart',
  'loanEnd',
  'boxNo',
  'temperature',
  'humidity',
  'bufferBatch',
  'insuranceNo',
  'insuranceExpiry',
  'sealNo'
];

class LoanError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function todayString(now) {
  return (now ? new Date(now) : new Date()).toISOString().slice(0, 10);
}

// 校验借展登记入参，返回规范化后的字段；不合法抛 400
function validateLoanInput(body) {
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = body[field];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
  if (missing.length) {
    throw new LoanError(400, 'missing required fields: ' + missing.join(', '));
  }

  const headIds = body.headIds;
  if (!Array.isArray(headIds) || headIds.length === 0 || headIds.some((id) => !isNonEmptyString(id))) {
    throw new LoanError(400, 'headIds must be a non-empty array of puppet head ids');
  }
  if (new Set(headIds).size !== headIds.length) {
    throw new LoanError(400, 'headIds contains duplicates');
  }

  if (!isDateString(body.loanStart) || !isDateString(body.loanEnd)) {
    throw new LoanError(400, 'loanStart/loanEnd must be YYYY-MM-DD dates');
  }
  if (body.loanStart > body.loanEnd) {
    throw new LoanError(400, 'loanStart must not be after loanEnd');
  }
  if (!isDateString(body.insuranceExpiry)) {
    throw new LoanError(400, 'insuranceExpiry must be a YYYY-MM-DD date');
  }

  const temperature = toNumber(body.temperature);
  if (temperature === null) throw new LoanError(400, 'temperature must be a number');
  const humidity = toNumber(body.humidity);
  if (humidity === null) throw new LoanError(400, 'humidity must be a number');

  return {
    headIds: [...headIds],
    venue: body.venue.trim(),
    loanStart: body.loanStart,
    loanEnd: body.loanEnd,
    boxNo: body.boxNo.trim(),
    temperature,
    humidity,
    bufferBatch: body.bufferBatch.trim(),
    insuranceNo: body.insuranceNo.trim(),
    insuranceExpiry: body.insuranceExpiry,
    sealNo: body.sealNo.trim(),
    handler: body.handler.trim(),
    note: typeof body.note === 'string' ? body.note : ''
  };
}

// 放行门禁：任一不满足只转待检，返回原因列表（空数组 = 通过）
function evaluateGate(loan, options = {}) {
  const reasons = [];
  if (!(loan.temperature >= TEMP_MIN && loan.temperature <= TEMP_MAX)) {
    reasons.push('温度越界：箱内 ' + loan.temperature + '℃ 不在 15~30℃');
  }
  if (!(loan.humidity <= HUMIDITY_MAX)) {
    reasons.push('湿度超标：箱内 ' + loan.humidity + '% 高于 65%');
  }
  if (!isDateString(loan.insuranceExpiry) || loan.insuranceExpiry < todayString(options.now)) {
    reasons.push('保险过期：保单 ' + loan.insuranceNo + ' 有效期至 ' + loan.insuranceExpiry);
  }
  if (options.sealInUse) {
    reasons.push('封条重复：封条号 ' + loan.sealNo + ' 已被其他借展单使用');
  }
  return reasons;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// 找出与候选档期重叠且仍未归还的其他借展单
function findOverlaps(loans, candidate, excludeId) {
  return loans.filter((loan) => {
    if (loan.id === excludeId) return false;
    if (!OCCUPYING_STATUSES.includes(loan.status)) return false;
    return rangesOverlap(loan.loanStart, loan.loanEnd, candidate.loanStart, candidate.loanEnd);
  });
}

// 创建借展单：先校验，再查偶头可借，再过门禁，最后查档期冲突
function planLoanCreation(body, context) {
  const fields = validateLoanInput(body);
  const heads = fields.headIds.map((headId) => {
    const head = context.getHead(headId);
    if (!head) throw new LoanError(400, '偶头不存在: ' + headId);
    return head;
  });
  const blocked = heads.filter((head) => !head.loanable);
  if (blocked.length) {
    throw new LoanError(409, '偶头当前不可借展', {
      blockedHeads: blocked.map((head) => ({ id: head.id, status: head.status }))
    });
  }

  const candidate = { ...fields };
  const gateReasons = evaluateGate(candidate, {
    now: context.now,
    sealInUse: context.isSealUsed(fields.sealNo, null)
  });

  if (gateReasons.length) {
    return { fields, status: STATUS.PENDING, gateReasons, conflicts: [] };
  }

  const conflicts = findOverlaps(context.listLoans(), candidate, null)
    .filter((loan) => loan.headIds.some((id) => fields.headIds.includes(id)));
  if (conflicts.length) {
    throw new LoanError(409, '档期冲突：同一偶头重叠档期已有未归还借展单', {
      conflicts: conflicts.map((loan) => ({
        loanId: loan.id,
        venue: loan.venue,
        loanStart: loan.loanStart,
        loanEnd: loan.loanEnd,
        headIds: loan.headIds.filter((id) => fields.headIds.includes(id))
      }))
    });
  }

  return { fields, status: STATUS.RELEASED, gateReasons: [], conflicts: [] };
}

// 构建待入库的借展单对象
function buildLoan(fields, status, gateReasons, nowIso) {
  return {
    ...fields,
    status,
    gateReasons: [...gateReasons],
    returnReview: null,
    dispatchedAt: null,
    returnedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

// 出借交接：只有已放行的单才能出库
function planDispatch(loan) {
  if (loan.status !== STATUS.RELEASED) {
    throw new LoanError(400, '只有已放行的借展单可以做出借交接，当前状态: ' + loan.status);
  }
  return { status: STATUS.ON_LOAN };
}

// 归还复核：必须由交接人之外的另一人复核外观与机关
function planReturn(loan, body) {
  if (loan.status !== STATUS.ON_LOAN) {
    throw new LoanError(400, '只有出借中的借展单可以归还复核，当前状态: ' + loan.status);
  }
  const reviewer = body && body.reviewer;
  if (!isNonEmptyString(reviewer)) {
    throw new LoanError(400, '归还复核必须指定 reviewer');
  }
  if (reviewer.trim() === loan.handler) {
    throw new LoanError(400, '归还复核人必须与交接人不同（交接人: ' + loan.handler + '）');
  }

  const appearanceOk = body.appearanceOk === true;
  const mechanismOk = body.mechanismOk === true;
  const perHead = {};
  for (const headId of loan.headIds) {
    const entry = body.perHead && body.perHead[headId];
    perHead[headId] = {
      appearanceOk: entry && entry.appearanceOk !== undefined ? entry.appearanceOk === true : appearanceOk,
      mechanismOk: entry && entry.mechanismOk !== undefined ? entry.mechanismOk === true : mechanismOk
    };
  }
  const abnormal = Object.values(perHead).some((item) => !item.appearanceOk || !item.mechanismOk);

  return {
    reviewer: reviewer.trim(),
    appearanceOk,
    mechanismOk,
    perHead,
    abnormal,
    note: typeof body.note === 'string' ? body.note : '',
    status: abnormal ? STATUS.RETURNED_ABNORMAL : STATUS.RETURNED
  };
}

// 更正：只允许白名单字段；档期/箱体/保险类改动会让放行失效重算
function planCorrection(loan, body) {
  if (![STATUS.PENDING, STATUS.RELEASED].includes(loan.status)) {
    throw new LoanError(400, '当前状态不允许更正（仅待检/已放行可更正），当前状态: ' + loan.status);
  }
  const keys = Object.keys(body || {}).filter((key) => !['action', 'actor', 'note'].includes(key));
  const unknown = keys.filter((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown.length) {
    throw new LoanError(400, '不允许更正的字段: ' + unknown.join(', '));
  }
  const changedKeys = keys.filter((key) => JSON.stringify(body[key]) !== JSON.stringify(loan[key]));
  if (!changedKeys.length) {
    throw new LoanError(400, '没有实际变更的字段');
  }

  const merged = { ...loan };
  for (const key of changedKeys) merged[key] = body[key];
  const fields = validateLoanInput({ ...merged, headIds: loan.headIds });

  const releasingChanged = changedKeys.some((key) => RELEASING_FIELDS.includes(key));
  return { fields, changedKeys, releasingChanged };
}

// 更正后的重算：门禁不过转待检；档期冲突拒绝整单更正（旧稿仍由调用方留档）
function planRecheck(loan, fields, context) {
  const gateReasons = evaluateGate(fields, {
    now: context.now,
    sealInUse: context.isSealUsed(fields.sealNo, loan.id)
  });
  if (gateReasons.length) {
    return { status: STATUS.PENDING, gateReasons, conflicts: [] };
  }
  const conflicts = findOverlaps(context.listLoans(), fields, loan.id)
    .filter((other) => other.headIds.some((id) => fields.headIds.includes(id)));
  if (conflicts.length) {
    throw new LoanError(409, '更正后档期冲突：同一偶头重叠档期已有未归还借展单', {
      conflicts: conflicts.map((other) => ({
        loanId: other.id,
        venue: other.venue,
        loanStart: other.loanStart,
        loanEnd: other.loanEnd,
        headIds: other.headIds.filter((id) => fields.headIds.includes(id))
      }))
    });
  }
  return { status: STATUS.RELEASED, gateReasons: [], conflicts: [] };
}

// 可借状态：与列表、履历同一份借展数据推导
function summarizeHeadAvailability(loans, headIds, start, end) {
  const result = {};
  for (const headId of headIds) {
    const occupying = loans.filter((loan) =>
      OCCUPYING_STATUSES.includes(loan.status) &&
      loan.headIds.includes(headId) &&
      rangesOverlap(loan.loanStart, loan.loanEnd, start, end)
    );
    const pending = loans.filter((loan) =>
      loan.status === STATUS.PENDING &&
      loan.headIds.includes(headId) &&
      rangesOverlap(loan.loanStart, loan.loanEnd, start, end)
    );
    result[headId] = {
      headId,
      available: occupying.length === 0,
      occupyingLoans: occupying.map((loan) => ({
        loanId: loan.id,
        venue: loan.venue,
        status: loan.status,
        loanStart: loan.loanStart,
        loanEnd: loan.loanEnd
      })),
      pendingLoans: pending.map((loan) => ({
        loanId: loan.id,
        venue: loan.venue,
        loanStart: loan.loanStart,
        loanEnd: loan.loanEnd
      }))
    };
  }
  return result;
}

module.exports = {
  STATUS,
  OCCUPYING_STATUSES,
  TEMP_MIN,
  TEMP_MAX,
  HUMIDITY_MAX,
  REQUIRED_FIELDS,
  EDITABLE_FIELDS,
  RELEASING_FIELDS,
  LoanError,
  isDateString,
  validateLoanInput,
  evaluateGate,
  rangesOverlap,
  findOverlaps,
  planLoanCreation,
  buildLoan,
  planDispatch,
  planReturn,
  planCorrection,
  planRecheck,
  summarizeHeadAvailability
};
