// 借展放行判定层：纯规则函数，不依赖 Express 与数据库。

const STATUS = {
  PENDING: '待检',
  RELEASED: '已放行',
  RETURNED: '已归还',
  REPAIR: '异常修复'
};

const LOAN_STATUSES = [STATUS.PENDING, STATUS.RELEASED, STATUS.RETURNED, STATUS.REPAIR];

// 占档期的未归还单：已放行在外，未归还也未因异常转修复
function occupiesSchedule(status) {
  return status === STATUS.RELEASED;
}

function isClosed(status) {
  return status === STATUS.RETURNED || status === STATUS.REPAIR;
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const TEMP_MIN = 15;
const TEMP_MAX = 30;
const HUMIDITY_MAX = 65;

const REQUIRED_FIELDS = [
  'puppetHeadId',
  'venue',
  'startDate',
  'endDate',
  'temperature',
  'humidity',
  'cushionBatch',
  'insurancePolicyNo',
  'insuranceExpireAt',
  'sealNo',
  'handler'
];

// 可以更正的字段：档期、箱体、保险、交接、缓冲材、备注
const CORRECTABLE_FIELDS = [
  'startDate',
  'endDate',
  'boxNo',
  'insurancePolicyNo',
  'insuranceExpireAt',
  'temperature',
  'humidity',
  'cushionBatch',
  'sealNo',
  'venue',
  'note'
];

// 改这些字段会让放行失效，需要重新判定档期与运输环境
const INVALIDATING_FIELDS = [
  'startDate',
  'endDate',
  'boxNo',
  'insurancePolicyNo',
  'insuranceExpireAt',
  'temperature',
  'humidity',
  'cushionBatch',
  'sealNo'
];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function parseDate(value, field) {
  if (isBlank(value)) {
    throw new HttpError(400, '缺少必填字段: ' + field);
  }
  const text = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new HttpError(400, '日期格式应为 YYYY-MM-DD: ' + field);
  }
  const date = new Date(text + 'T00:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new HttpError(400, '日期不合法: ' + field);
  }
  return date;
}

function todayStart() {
  const now = new Date();
  return new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
}

// 半开区间重叠：start < other.end && end > other.start
function rangesOverlap(start, end, otherStart, otherEnd) {
  return start.getTime() < otherEnd.getTime() && end.getTime() > otherStart.getTime();
}

function validateBase(body) {
  const missing = REQUIRED_FIELDS.filter((field) => isBlank(body[field]));
  if (missing.length) {
    throw new HttpError(400, '缺少必填字段: ' + missing.join(', '));
  }

  const temperature = Number(body.temperature);
  if (!Number.isFinite(temperature)) {
    throw new HttpError(400, '箱内温度必须是数字');
  }
  const humidity = Number(body.humidity);
  if (!Number.isFinite(humidity)) {
    throw new HttpError(400, '箱内湿度必须是数字');
  }

  const start = parseDate(body.startDate, 'startDate');
  const end = parseDate(body.endDate, 'endDate');
  if (end.getTime() <= start.getTime()) {
    throw new HttpError(400, '结束日期必须晚于开始日期');
  }

  parseDate(body.insuranceExpireAt, 'insuranceExpireAt');

  return { temperature, humidity };
}

// 运输环境与保险、封条判定。返回 { passed, reasons }。
// 不合格只转待检，不占档期；封条重复同样只转待检（在入口层保证数据）。
function evaluateClearance(snapshot, context) {
  const ctx = context || {};
  const reasons = [];

  if (snapshot.temperature < TEMP_MIN || snapshot.temperature > TEMP_MAX) {
    reasons.push('箱内温度 ' + snapshot.temperature + '℃ 不在 ' + TEMP_MIN + '~' + TEMP_MAX + '℃ 区间');
  }
  if (snapshot.humidity > HUMIDITY_MAX) {
    reasons.push('箱内湿度 ' + snapshot.humidity + '% 高于 ' + HUMIDITY_MAX + '%');
  }

  const expireAt = parseDate(snapshot.insuranceExpireAt, 'insuranceExpireAt');
  if (expireAt.getTime() < todayStart().getTime()) {
    reasons.push('保险单号 ' + snapshot.insurancePolicyNo + ' 已过期（' + snapshot.insuranceExpireAt + '）');
  }

  if (ctx.sealDuplicated) {
    reasons.push('封条号重复: ' + snapshot.sealNo);
  }

  const headReasons = headUnusableReasons(ctx.head);
  reasons.push(...headReasons);

  return { passed: reasons.length === 0, reasons };
}

// 偶头自身是否具备出借条件
function headUnusableReasons(head) {
  if (!head) {
    throw new HttpError(404, '偶头档案不存在');
  }
  const reasons = [];
  if (head.currentUsable === false) {
    reasons.push('偶头非可借状态（currentUsable=false）');
  }
  if (head.status && head.status !== '可演出') {
    reasons.push('偶头状态为「' + head.status + '」，不可出借');
  }
  return reasons;
}

// 偶头可借状态：与列表、履历共用同一口径
function headAvailability(head, blockingLoans, range) {
  const reasons = headUnusableReasons(head);
  const busy = (blockingLoans || []).filter((loan) =>
    rangesOverlap(
      parseDate(loan.startDate, 'startDate'),
      parseDate(loan.endDate, 'endDate'),
      range.start,
      range.end
    )
  );
  if (busy.length) {
    reasons.push('重叠档期已有未归还借展单: ' + busy.map((loan) => loan.id).join(', '));
  }
  return {
    puppetHeadId: head.id,
    available: reasons.length === 0,
    reasons,
    blockingLoans: busy
  };
}

function validateReturnBody(body) {
  const missing = ['reviewer', 'appearanceOk', 'mechanismOk'].filter((field) =>
    body[field] === undefined || body[field] === null || String(body[field]).trim() === ''
  );
  if (missing.length) {
    throw new HttpError(400, '归还复核缺少必填字段: ' + missing.join(', '));
  }
  if (![true, false].includes(body.appearanceOk) || ![true, false].includes(body.mechanismOk)) {
    throw new HttpError(400, 'appearanceOk 与 mechanismOk 必须为布尔值');
  }
}

module.exports = {
  STATUS,
  LOAN_STATUSES,
  TEMP_MIN,
  TEMP_MAX,
  HUMIDITY_MAX,
  REQUIRED_FIELDS,
  CORRECTABLE_FIELDS,
  INVALIDATING_FIELDS,
  HttpError,
  isBlank,
  parseDate,
  rangesOverlap,
  occupiesSchedule,
  isClosed,
  validateBase,
  evaluateClearance,
  headUnusableReasons,
  headAvailability,
  validateReturnBody
};
