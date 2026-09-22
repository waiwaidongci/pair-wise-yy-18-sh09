module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头借展与运输环境放行台',
  description: '维护偶头档案、服装配件、修补流转、巡演装箱、返场缺损，并登记偶头借展单：按展馆与档期锁定偶头，核验箱内温湿度、缓冲材、保险与封条后放行。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '花旦',
        play: '荔镜记',
        paintStatus: '完好',
        mechanism: '转眼机关顺畅',
        accessories: ['点翠头面', '水袖'],
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '可外借展出'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-3',
      status: '可演出',
      data: {
        role: '黑脸净',
        play: '钟馗行路',
        paintStatus: '完好',
        mechanism: '张口机关顺畅',
        accessories: ['黑满髯', '判官笔'],
        boxNo: '木箱甲-02',
        currentUsable: true
      },
      note: '可外借展出'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    }
  ],
  examples: [
    'POST /api/loans 登记借展单（温度15~30℃、湿度≤65%、保险有效、封条不重复才放行，否则转待检；档期冲突返回409整单不写）',
    'GET /api/loans/availability?puppetHeadId=head-seed-2&startDate=2026-10-01&endDate=2026-10-08 查询可借状态',
    'POST /api/loans/:id/return 另一人复核外观与机关，异常只进修复',
    'PATCH /api/loans/:id 更正档期/箱体/保险，放行失效重算，旧稿留档',
    'GET /api/loans/:id/timeline 查看借展履历与旧稿',
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
