module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
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
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '火眼机关正常',
        accessories: ['金箍棒', '虎皮裙'],
        boxNo: '木箱甲-01',
        currentUsable: true
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-3',
      status: '可演出',
      data: {
        role: '铁扇公主',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '扇面开合正常',
        accessories: ['芭蕉扇'],
        boxNo: '木箱甲-02',
        currentUsable: true
      }
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
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/loans 登记借展单（温湿度、缓冲材、保险、封条、交接人）',
    'POST /api/loans/:id/dispatch 放行后出借交接',
    'POST /api/loans/:id/return 另一人复核外观与机关',
    'PATCH /api/loans/:id 档期/箱体/保险更正，放行失效重算，旧稿留档',
    'GET /api/loans/availability?start=2026-10-01&end=2026-10-05 查可借状态',
    'GET /api/loans/:id/timeline 借展履历与旧稿'
  ],
  loanSeed: [
    {
      id: 'loan-seed-1',
      venue: '泉州海交馆',
      loanStart: '2026-10-01',
      loanEnd: '2026-10-07',
      boxNo: '运输箱甲-01',
      temperature: 22,
      humidity: 55,
      bufferBatch: '缓冲材2026-08批',
      insuranceNo: 'INS-2026-1001',
      insuranceExpiry: '2026-12-31',
      sealNo: 'SEAL-0001',
      handler: '陈班主',
      headIds: ['head-seed-2']
    }
  ]
};
