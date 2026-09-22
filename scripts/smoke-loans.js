const BASE = 'http://localhost:3914/api';

let pass = 0;
let fail = 0;

function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const goodPayload = (overrides = {}) => ({
  puppetHeadId: 'head-seed-2',
  venue: '泉州非遗馆',
  startDate: '2026-10-01',
  endDate: '2026-10-10',
  temperature: 22,
  humidity: 55,
  cushionBatch: '缓冲批次-A01',
  insurancePolicyNo: 'INS-2026-0001',
  insuranceExpireAt: '2026-12-31',
  sealNo: 'SEAL-' + Math.random().toString(36).slice(2, 9),
  handler: '陈交接',
  boxNo: '木箱甲-01',
  ...overrides
});

(async () => {
  // 1. 正常登记 → 已放行
  let r = await api('POST', '/loans', goodPayload());
  check('1 环境合格登记后放行', r.status === 201 && r.body.status === '已放行', r);
  const loanA = r.body;

  // 2. 同偶头重叠档期 → 409 且整单不写
  const beforeCount = (await api('GET', '/loans')).body.length;
  r = await api('POST', '/loans', goodPayload({
    venue: '厦门文化馆',
    startDate: '2026-10-05',
    endDate: '2026-10-15',
    insurancePolicyNo: 'INS-2026-0002',
    sealNo: 'SEAL-OTHER-1'
  }));
  const afterCount = (await api('GET', '/loans')).body.length;
  check('2 重叠档期返回409', r.status === 409 && Array.isArray(r.body.details.conflicts) && r.body.details.conflicts[0].id === loanA.id, r.body);
  check('2b 冲突整单不写', beforeCount === afterCount, { beforeCount, afterCount });

  // 相邻不重叠档期（end=10-01 另一个 start=10-10，半开区间不重叠）
  r = await api('POST', '/loans', goodPayload({
    venue: '厦门文化馆',
    startDate: '2026-10-10',
    endDate: '2026-10-20',
    insurancePolicyNo: 'INS-2026-0003',
    sealNo: 'SEAL-ADJACENT'
  }));
  check('3 相邻档期可再登记', r.status === 201 && r.body.status === '已放行', r);
  const loanB = r.body;

  // 4. 温度超限 → 只转待检，不占档期
  r = await api('POST', '/loans', goodPayload({
    startDate: '2026-11-01',
    endDate: '2026-11-05',
    temperature: 31,
    insurancePolicyNo: 'INS-X1',
    sealNo: 'SEAL-HOT'
  }));
  check('4 温度超30℃转待检', r.status === 201 && r.body.status === '待检' && r.body.clearanceReasons.some(x => x.includes('温度')), r);

  r = await api('POST', '/loans', goodPayload({
    startDate: '2026-11-01',
    endDate: '2026-11-05',
    temperature: 14,
    insurancePolicyNo: 'INS-X2',
    sealNo: 'SEAL-COLD'
  }));
  check('4b 温度低于15℃转待检', r.status === 201 && r.body.status === '待检', r);

  // 5. 湿度超65 → 待检
  r = await api('POST', '/loans', goodPayload({
    startDate: '2026-11-06',
    endDate: '2026-11-09',
    humidity: 65.1,
    insurancePolicyNo: 'INS-X3',
    sealNo: 'SEAL-HUMID'
  }));
  check('5 湿度高于65%转待检', r.status === 201 && r.body.status === '待检' && r.body.clearanceReasons.some(x => x.includes('湿度')), r);

  // 湿度恰好65 应放行
  r = await api('POST', '/loans', goodPayload({
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    humidity: 65,
    insurancePolicyNo: 'INS-X4',
    sealNo: 'SEAL-H65'
  }));
  check('5b 湿度恰好65%放行', r.status === 201 && r.body.status === '已放行', r);

  // 6. 保险过期 → 待检
  r = await api('POST', '/loans', goodPayload({
    startDate: '2026-11-13',
    endDate: '2026-11-15',
    insuranceExpireAt: '2026-09-01',
    insurancePolicyNo: 'INS-OLD',
    sealNo: 'SEAL-OLDINS'
  }));
  check('6 保险过期转待检', r.status === 201 && r.body.status === '待检' && r.body.clearanceReasons.some(x => x.includes('保险')), r);

  // 7. 封条重复 → 待检（不报错，只不占档期）
  r = await api('POST', '/loans', goodPayload({
    puppetHeadId: 'head-seed-3',
    startDate: '2026-11-20',
    endDate: '2026-11-25',
    sealNo: loanA.sealNo,
    insurancePolicyNo: 'INS-DUP',
    handler: '李交接'
  }));
  check('7 封条重复转待检', r.status === 201 && r.body.status === '待检' && r.body.clearanceReasons.some(x => x.includes('封条')), r);

  // 待检单不占档期：与 loanA 完全重叠但因待检而允许存在（已验证上面 11月的）；
  // 且一只偶头 10月重叠档期仍只有 loanA 一张放行单
  r = await api('GET', '/loans?puppetHeadId=head-seed-2&status=已放行');
  const octReleased = r.body.filter(l => l.startDate < '2026-10-10' && l.endDate > '2026-10-01');
  check('8 待检单不占档期（10-01~10-10重叠区间内仅一张放行单）', octReleased.length === 1 && octReleased[0].id === loanA.id, octReleased);

  // 待检单不能直接归还
  const pending = (await api('GET', '/loans?status=待检')).body[0];
  r = await api('POST', '/loans/' + pending.id + '/return', { reviewer: '王复核', appearanceOk: true, mechanismOk: true });
  check('9 待检单不能直接归还', r.status === 400, r);

  // 10. 归还人不得是交接人本人
  r = await api('POST', '/loans/' + loanA.id + '/return', { reviewer: '陈交接', appearanceOk: true, mechanismOk: true });
  check('10 交接人本人不能复核', r.status === 400, r);

  // 11. 另一人复核通过 → 已归还，档期释放
  r = await api('POST', '/loans/' + loanA.id + '/return', { reviewer: '王复核', appearanceOk: true, mechanismOk: true });
  check('11 复核通过已归还', r.status === 200 && r.body.status === '已归还', r);

  // 归还后该档期可再借
  r = await api('GET', '/loans/availability?puppetHeadId=head-seed-2&startDate=2026-10-01&endDate=2026-10-10');
  check('12 归还后档期可借', r.status === 200 && r.body.available === true, r);

  // 与 loanB(10-10~10-20) 重叠仍不可借
  r = await api('GET', '/loans/availability?puppetHeadId=head-seed-2&startDate=2026-10-15&endDate=2026-10-18');
  check('13 占用档期内不可借且给出阻挡单', r.body.available === false && r.body.blockingLoans.some(l => l.id === loanB.id), r);

  // 不可用偶头（待修补）不可借
  r = await api('GET', '/loans/availability?puppetHeadId=head-seed-1&startDate=2026-10-01&endDate=2026-10-10');
  check('14 待修补偶头不可借', r.body.available === false && r.body.reasons.some(x => x.includes('可借') || x.includes('状态')), r);

  // 给待修补偶头登记借展 → 只能待检
  r = await api('POST', '/loans', goodPayload({
    puppetHeadId: 'head-seed-1',
    startDate: '2026-12-01',
    endDate: '2026-12-05',
    insurancePolicyNo: 'INS-H1',
    sealNo: 'SEAL-H1'
  }));
  check('14b 不可借偶头登记只转待检', r.status === 201 && r.body.status === '待检' && r.body.clearanceReasons.some(x => x.includes('偶头')), r);

  // 15. 异常归还 → 异常修复，生成 repairRecords，偶头转修补中
  r = await api('POST', '/loans/' + loanB.id + '/return', { reviewer: '王复核', appearanceOk: false, mechanismOk: true, note: '左颊有新划痕' });
  check('15 异常归还进修复状态', r.status === 200 && r.body.status === '异常修复', r);
  const repairs = (await api('GET', '/repairRecords?repairType=借展归还异常')).body;
  check('15b 自动生成修复记录', repairs.some(x => x.sourceLoanId === loanB.id && x.appearanceOk === false), repairs);
  const head = (await api('GET', '/puppetHeads/head-seed-2')).body;
  check('15c 偶头转修补中且不可借', head.status === '修补中' && head.currentUsable === false, head);
  // 修复后偶头不再放行新单
  r = await api('POST', '/loans', goodPayload({
    startDate: '2027-01-01',
    endDate: '2027-01-05',
    insurancePolicyNo: 'INS-AFTER',
    sealNo: 'SEAL-AFTER'
  }));
  check('15d 修补中偶头新单只转待检', r.body.status === '待检', r);

  // 16. 更正：改档期 → 放行失效重算；与其他单冲突 → 409 旧稿保留
  // 先再造一张放行单（head-seed-3）
  r = await api('POST', '/loans', goodPayload({
    puppetHeadId: 'head-seed-3',
    venue: '漳州木偶馆',
    startDate: '2027-02-01',
    endDate: '2027-02-10',
    insurancePolicyNo: 'INS-Z1',
    sealNo: 'SEAL-Z1',
    handler: '林交接'
  }));
  check('16 准备第二只偶头放行单', r.body.status === '已放行', r);
  const loanC = r.body;

  r = await api('POST', '/loans', goodPayload({
    puppetHeadId: 'head-seed-3',
    venue: '福州戏楼',
    startDate: '2027-02-15',
    endDate: '2027-02-20',
    insurancePolicyNo: 'INS-Z2',
    sealNo: 'SEAL-Z2',
    handler: '林交接'
  }));
  check('16b 同偶头非重叠可放行', r.body.status === '已放行', r);
  const loanD = r.body;

  // 把 loanC 档期改到与 loanD 重叠 → 409
  const before = await api('GET', '/loans/' + loanC.id);
  r = await api('PATCH', '/loans/' + loanC.id, { startDate: '2027-02-16', endDate: '2027-02-25', actor: '馆方' });
  check('17 档期更正冲突返回409', r.status === 409, r);
  const after = await api('GET', '/loans/' + loanC.id);
  check('17b 冲突时旧稿保留（档期与版本不变）',
    after.body.startDate === before.body.startDate && after.body.endDate === before.body.endDate && after.body.version === before.body.version,
    { before: before.body.startDate + '~' + before.body.endDate + ' v' + before.body.version, after: after.body.startDate + '~' + after.body.endDate + ' v' + after.body.version });

  // 保险改过期 → 放行失效转待检，旧稿留档
  r = await api('PATCH', '/loans/' + loanC.id, { insuranceExpireAt: '2026-01-01', actor: '馆方' });
  check('18 保险更正为过期后转待检', r.status === 200 && r.body.status === '待检' && r.body.version === 2 && r.body.clearanceReasons.some(x => x.includes('保险')), r);
  // 改回有效保险 → 重新放行
  r = await api('PATCH', '/loans/' + loanC.id, { insuranceExpireAt: '2028-01-01', actor: '馆方' });
  check('18b 保险补正后重新放行', r.body.status === '已放行' && r.body.version === 3 && r.body.clearanceReasons.length === 0, r);

  // 箱体（boxNo）更正也触发放行重算：改成一个温度记录…其实 boxNo 本身不判，只是要素失效；改成坏温度才会待检
  r = await api('PATCH', '/loans/' + loanC.id, { boxNo: '木箱丁-09', temperature: 28, actor: '馆方' });
  check('19 箱体更正触发重算仍合格', r.status === 200 && r.body.status === '已放行' && r.body.version === 4 && r.body.boxNo === '木箱丁-09', r);
  r = await api('PATCH', '/loans/' + loanC.id, { temperature: 32, actor: '馆方' });
  check('19b 温度更正不合格转待检', r.body.status === '待检' && r.body.version === 5, r);

  // 非失效字段（note）不改状态不升判定
  r = await api('PATCH', '/loans/' + loanC.id, { note: '馆方电话已确认', actor: '馆方' });
  check('20 备注更正不影响放行判定', r.body.status === '待检' && r.body.version === 6 && r.body.note === '馆方电话已确认', r);

  // 履历：事件 + 旧稿修订都在
  r = await api('GET', '/loans/' + loanC.id + '/timeline');
  check('21 履历含事件与旧稿', r.status === 200 &&
    r.body.events.length >= 5 &&
    r.body.revisions.length === 5 &&
    r.body.revisions[0].version === 1 &&
    r.body.revisions[0].snapshot.insuranceExpireAt === '2026-12-31',
    { events: r.body.events?.length, revisions: r.body.revisions?.length, firstRev: r.body.revisions && r.body.revisions[0] });

  // 已闭环单不可更正
  r = await api('PATCH', '/loans/' + loanA.id, { note: 'x' });
  check('22 已归还单不可更正', r.status === 400, r);
  r = await api('PATCH', '/loans/' + loanB.id, { note: 'x' });
  check('22b 异常修复单不可更正', r.status === 400, r);

  // 列表口径一致：履历/列表中占用档期的放行单即可借状态的阻挡单
  const listBlocking = (await api('GET', '/loans?puppetHeadId=head-seed-3&status=已放行')).body;
  const avail = (await api('GET', '/loans/availability?puppetHeadId=head-seed-3&startDate=2027-02-01&endDate=2027-02-10')).body;
  check('23 列表与可借状态口径一致', listBlocking.some(l => l.id === loanC.id) === false || avail.available === false, { listBlocking: listBlocking.map(l => l.id), avail });
  // 注：loanC 当前待检（温度32），不占档期，故该档期应可借
  check('23b 待检更正单释放档期，可借状态一致', avail.available === true && !avail.blockingLoans.some(l => l.id === loanC.id), avail);

  // 缺少必填字段 → 400
  r = await api('POST', '/loans', { puppetHeadId: 'head-seed-3' });
  check('24 缺字段400', r.status === 400 && r.body.error.includes('缺少必填字段'), r);

  // 未知偶头 → 404
  r = await api('POST', '/loans', goodPayload({ puppetHeadId: 'no-such-head', sealNo: 'SEAL-NONE' }));
  check('25 未知偶头404', r.status === 404, r);

  // 通用记录 API 仍可用
  r = await api('GET', '/accessories');
  check('26 通用集合 API 正常', r.status === 200 && r.body.some(x => x.name === '红缨冠'), r);

  // 列表过滤 venue
  r = await api('GET', '/loans?venue=漳州');
  check('27 按展馆过滤', r.body.length >= 1 && r.body.every(l => l.venue.includes('漳州')), r.body.map(l => l.venue));

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
