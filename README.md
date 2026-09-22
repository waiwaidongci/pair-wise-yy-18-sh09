# 传统木偶戏班偶头借展与运输环境放行台

在原有偶头、服装配件、修补流转、巡演装箱、返场缺损记录 API 之上，扩展偶头借展与运输环境放行业务：按展馆和档期登记借展单、核验箱内运输环境后放行、归还双人复核、更正留档重算。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

首次启动会在 `data/app.db` 创建 SQLite 数据库（通过 sql.js/WASM 落盘，不依赖系统 sqlite3）。

## 代码结构（三层分离）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `routes/loans.js` | HTTP 路由、参数搬运、状态码映射 |
| 判定 | `business/loanRules.js` | 档期重叠、温湿度/保险/封条/偶头状态等纯规则，不依赖 Express 与 SQL |
| 存储 | `business/loanStore.js` | 借展单、档期锁定、旧稿留档、事件履历、修复联动（事务） |
| 共享 | `lib/db.js` | SQLite 访问、事务、落盘 |
| 通用记录 | `server.js` | 原通用集合 CRUD 与事件履历，挂载借展入口 |

## 借展规则

- **档期锁定**：一张借展单对应一只偶头、一个展馆和一段档期（半开区间，`startDate/endDate` 为 `YYYY-MM-DD`）。同一偶头重叠档期只允许存在一张未归还（`已放行`）单；冲突返回 **409**，整单不写。
- **出借前登记**：箱内温度、湿度、缓冲材批次、保险单号、保险到期日、封条号、交接人、箱体编号。
- **放行判定**：温度需在 15~30℃、湿度不得高于 65%、保险未过期、封条不得与其他单重复、偶头处于可借状态。任一不满足时单据只转为 **待检**，**不占档期**，补齐后可通过更正重新放行。
- **归还复核**：必须由交接人之外的另一人复核外观与机关。两项均正常 → `已归还` 并释放档期；任一异常 → `异常修复`，自动生成 `repairRecords` 修复单，偶头转为 `修补中`、`currentUsable=false`。
- **更正留档**：更正档期、箱体、保险（及温湿度、缓冲材、封条）会让原放行失效并按新稿整单重算；每次更正在 `loan_revisions` 留存旧稿。更正后档期冲突同样返回 409，旧稿保留。已闭环（已归还/异常修复）单据不可更正。
- **口径一致**：列表、履历、可借状态查询共用同一套占档期口径（仅 `已放行` 单占档期）。

## 借展接口

- `POST /api/loans` 登记借展单（合格→`已放行`；环境不合格→`待检`；冲突→409）
- `GET /api/loans` 列表，支持 `status`、`puppetHeadId`、`venue`、`search`、`limit`
- `GET /api/loans/:id` 单据详情
- `PATCH /api/loans/:id` 更正（档期/箱体/保险等变更触发重算，旧稿留档）
- `POST /api/loans/:id/return` 归还复核（body：`reviewer`、`appearanceOk`、`mechanismOk`）
- `GET /api/loans/availability?puppetHeadId=..&startDate=..&endDate=..` 可借状态与阻挡单
- `GET /api/loans/:id/timeline` 履历（事件流 + 历次旧稿）

### 请求示例

```bash
curl -X POST http://localhost:3914/api/loans -H 'Content-Type: application/json' -d '{
  "puppetHeadId": "head-seed-2",
  "venue": "泉州非遗馆",
  "startDate": "2026-10-01",
  "endDate": "2026-10-10",
  "temperature": 22,
  "humidity": 55,
  "cushionBatch": "缓冲批次-A01",
  "insurancePolicyNo": "INS-2026-0001",
  "insuranceExpireAt": "2026-12-31",
  "sealNo": "SEAL-0001",
  "handler": "陈交接",
  "boxNo": "木箱甲-01"
}'
```

## 原通用接口（保持可用）

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 冒烟测试

先启动服务，再运行端到端用例（覆盖放行、409 整单不写、待检不占档期、双人复核、异常转修、更正重算与旧稿、口径一致性等 40 项）：

```bash
node scripts/smoke-loans.js
```
