/** Deterministic demonstration data; never represents a real business. */
export function salesExample () {
  const months = ['1月', '2月', '3月', '4月', '5月', '6月']
  const revenue = [82, 94, 90, 108, 121, 133]
  const cost = [60, 66, 71, 74, 80, 86]
  const sum = values => values.reduce((a, b) => a + b, 0)
  const total = sum(revenue)
  const profit = total - sum(cost)
  const margin = Number((profit / total * 100).toFixed(1))
  const growth = Number(((revenue[5] / revenue[4] - 1) * 100).toFixed(1))
  const regions = ['华东', '华南', '华北', '西南']
  const regionRevenue = [230, 175, 140, 83]
  const regionCost = [160, 122, 97, 58]
  const channels = ['直销', '渠道', '电商', '其他']
  const shares = [44, 30, 18, 8]
  const frame = { tooltip: { trigger: 'axis' }, legend: { top: 0 }, grid: { left: 48, right: 20, top: 45, bottom: 30 } }
  const cards = [
    { type: 'kpi', title: '上半年营收', presentation_spec: { value: total, unit: '万元', label: '模拟数据 · 2026 年 1—6 月', target: 660 }, layout: { x: 0, y: 0, w: 22, h: 8 }, query: 'SUM(月度营收)；上半年目标为 660 万元' },
    { type: 'kpi', title: '上半年毛利', presentation_spec: { value: profit, unit: '万元', label: '营收 − 成本（不含其他费用）' }, layout: { x: 24, y: 0, w: 22, h: 8 }, query: 'SUM(月度营收) - SUM(月度成本)' },
    { type: 'kpi', title: '整体毛利率', presentation_spec: { value: margin, unit: '%', label: '按营收加权，非月度比例平均值' }, layout: { x: 48, y: 0, w: 22, h: 8 }, query: '(628 - 437) / 628 * 100，保留 1 位小数' },
    { type: 'kpi', title: '6 月营收环比', presentation_spec: { value: growth, unit: '%', label: '6 月 133 万元 / 5 月 121 万元' }, layout: { x: 72, y: 0, w: 24, h: 8 }, query: '(133 / 121 - 1) * 100，保留 1 位小数' },
    { type: 'chart', title: '营收与成本趋势（万元）', chart_type: 'line', layout: { x: 0, y: 9, w: 47, h: 16 }, query: '按月汇总模拟营收和成本', echarts_option: { ...frame, xAxis: { type: 'category', data: months }, yAxis: { type: 'value' }, series: [{ name: '营收', type: 'line', data: revenue }, { name: '成本', type: 'line', data: cost }] } },
    { type: 'chart', title: '区域营收与毛利（万元）', chart_type: 'bar', layout: { x: 49, y: 9, w: 47, h: 16 }, query: '按区域汇总营收；毛利 = 区域营收 - 区域成本', echarts_option: { ...frame, xAxis: { type: 'category', data: regions }, yAxis: { type: 'value' }, series: [{ name: '营收', type: 'bar', data: regionRevenue }, { name: '毛利', type: 'bar', data: regionRevenue.map((v, i) => v - regionCost[i]) }] } },
    { type: 'chart', title: '渠道营收占比', chart_type: 'pie', layout: { x: 0, y: 26, w: 38, h: 16 }, query: '各渠道营收 = 总营收 628 万元 × 模拟占比；占比合计 100%', echarts_option: { tooltip: { trigger: 'item', formatter: '{b}: {c} 万元 ({d}%)' }, legend: { bottom: 0 }, series: [{ type: 'pie', radius: ['35%', '65%'], center: ['50%', '45%'], data: channels.map((name, i) => ({ name, value: Number((total * shares[i] / 100).toFixed(2)) })) }] } },
    { type: 'table', title: '月度经营明细（金额：万元）', layout: { x: 40, y: 26, w: 56, h: 16 }, query: '月度毛利 = 营收 - 成本；毛利率 = 毛利 / 营收', table_data: { columns: ['月份', '营收', '成本', '毛利', '毛利率'].map(name => ({ name })), rows: [...months.map((month, i) => [month, revenue[i], cost[i], revenue[i] - cost[i], `${((revenue[i] - cost[i]) / revenue[i] * 100).toFixed(1)}%`]), ['合计', total, sum(cost), profit, `${margin}%`]] } },
    { type: 'text', title: '结论与建议（模拟案例）', layout: { x: 0, y: 43, w: 47, h: 14 }, query: '根据画布中的模拟汇总数据计算；建议仅用于演示', text_content: `## 经营概览\n- 上半年营收 **${total} 万元**，完成目标的 **${(total / 660 * 100).toFixed(1)}%**，差额 **${660 - total} 万元**。\n- 毛利 **${profit} 万元**，整体毛利率 **${margin}%**。\n- 6 月营收环比增长 **${growth}%**。\n- 华东营收 **230 万元**，占总额 **${(230 / total * 100).toFixed(1)}%**。\n## 可继续分析\n核查 3 月成本上升的原因，并结合渠道获客成本比较投入效率。当前数据不足以判断因果。\n\n**全部为模拟数据，不代表真实业务。**` },
    { type: 'code', title: '复核计算（Python）', language: 'python', layout: { x: 49, y: 43, w: 47, h: 14 }, query: '复核 KPI 数值的 Python 代码，展示用，不会自动执行', text_content: '# 模拟数据，金额单位：万元\nrevenue = [82, 94, 90, 108, 121, 133]\ncost = [60, 66, 71, 74, 80, 86]\ntotal = sum(revenue)\nprofit = total - sum(cost)\nprint(total, profit)  # 628, 191\nprint(round(profit / total * 100, 1))  # 30.4\nprint(round((133 / 121 - 1) * 100, 1))  # 9.9' },
  ]
  return {
    name: '销售经营分析（模拟案例）',
    description: '2026 年上半年模拟销售经营数据，演示指标、趋势、区域、渠道、明细和结论。所有数据均为虚构。',
    cards: cards.map(card => ({ ...card, dataset: '内置模拟数据 · 非真实业务', source_note: '仅用于体验分析画布功能' })),
  }
}
