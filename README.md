# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、返场缺损追踪，并提供偶头借展与运输环境放行台。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

数据用纯 WASM 的 sql.js 存储，首次启动在 `data/app.db` 建库。

## 借展放行台（三个业务文件）

| 文件 | 职责 |
| --- | --- |
| `loanRoutes.js` | 入口：HTTP 路由、参数装配、400/404/409 状态码映射 |
| `loanRules.js` | 判定：门禁、档期重叠、归还复核、更正重算等纯业务规则 |
| `loanStore.js` | 存储：`loans` / `loan_events` / `loan_revisions` 三张表与全部读写 |

`server.js` 只做组装；`db.js` 封装事务与落盘。

### 业务规则

- 借展单按**展馆 + 档期**锁定偶头；同一偶头重叠档期只允许一张未归还单（已放行/出借中占档期），冲突返回 `409`，**整单不写**。
- 出借前必须登记：箱内温度、湿度、缓冲材批次、保险单号/有效期、封条号、交接人。
- 温度不在 15~30℃（含端点）、湿度高于 65%、保险过期或封条号被他单使用时，只转**待检**，不占档期；待检单不能出借交接。
- `POST /api/loans/:id/dispatch`：已放行单交接出库，变为出借中。
- `POST /api/loans/:id/return`：必须由**交接人之外的另一人**复核外观与机关；正常→已归还并释放档期，异常→归还异常，偶头只进修复（写 `repairRecords`、偶头转待修补，不会自动回到可借）。
- `PATCH /api/loans/:id`：档期、箱体或保险等放行相关字段更正时放行失效、按新值重算；每次更正先把旧稿写入 `loan_revisions` 留档。重算后档期冲突返回 409 且旧单不变。出借中及归还终态不允许更正。
- 列表（`GET /api/puppetHeads` 的 `loanState`）、履历（`GET /api/loans/:id/timeline`）与可借状态（`GET /api/loans/availability`）由同一份借展数据推导。

### 借展接口

- `POST /api/loans` 登记借展单（自动判定放行/待检）
- `GET  /api/loans?status=&venue=&headId=` 借展单列表
- `GET  /api/loans/:id` 借展单详情
- `GET  /api/loans/:id/timeline` 履历事件 + 更正旧稿
- `POST /api/loans/:id/dispatch` 出借交接
- `POST /api/loans/:id/return` 归还复核（`reviewer` 须不同于 `handler`）
- `PATCH /api/loans/:id` 更正（白名单字段，放行重算）
- `GET  /api/loans/availability?start=YYYY-MM-DD&end=YYYY-MM-DD&headIds=a,b` 可借状态

登记请求示例：

```json
{
  "headIds": ["head-seed-3"],
  "venue": "泉州海交馆",
  "loanStart": "2026-10-01",
  "loanEnd": "2026-10-07",
  "boxNo": "运输箱甲-01",
  "temperature": 22,
  "humidity": 55,
  "bufferBatch": "缓冲材2026-08批",
  "insuranceNo": "INS-2026-1001",
  "insuranceExpiry": "2026-12-31",
  "sealNo": "SEAL-0001",
  "handler": "陈班主"
}
```

## 原有记录接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`
