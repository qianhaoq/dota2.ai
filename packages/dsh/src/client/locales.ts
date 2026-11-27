export const zh = {
  title: 'dota2.ai',
  open: '在 dota2.ai 页面打开',
  openHome: '打开 dota2.ai 工作台',
  details: '工具原始返回',
  statusReady: '复盘已就绪',
  statusWorking: '正在准备复盘…',
  statusPick: '等待选择英雄',
  renderErrorTitle: '页面视图暂时无法显示',
  renderErrorBody: '本地已保存的录像缓存、复盘与训练目标均完好保留。',
  restore: '重新加载视图',
} as const;

export const en = {
  title: 'dota2.ai',
  open: 'Open in dota2.ai',
  openHome: 'Open dota2.ai workbench',
  details: 'Raw tool output',
  statusReady: 'Review ready',
  statusWorking: 'Working on review…',
  statusPick: 'Pick your hero',
  renderErrorTitle: 'This view could not be displayed',
  renderErrorBody: 'Your cached replays, reviews and training goals are safe.',
  restore: 'Reload view',
} as const;

export type LocaleKey = keyof typeof en;
