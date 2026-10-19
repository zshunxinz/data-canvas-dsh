"""生成示例零售订单数据（examples/retail-orders.csv）。

用法：
    python scripts/make-example-data.py [out.csv]

固定随机种子，结果可复现；1200 行、19 列，含少量缺失值，
用于新用户装好插件后直接导入体验“导入 → 查询 → 落卡”。
"""
import csv
import random
import sys
from datetime import date, timedelta
from pathlib import Path

random.seed(20250101)

ROWS = 1200
START = date(2025, 1, 1)
DAYS = 365

STORES = [
    ("华东-上海店", "上海", 0.28),
    ("华北-北京店", "北京", 0.22),
    ("华南-广州店", "广州", 0.18),
    ("西南-成都店", "成都", 0.14),
    ("华中-武汉店", "武汉", 0.10),
    ("西北-西安店", "西安", 0.08),
]
CHANNELS = ["门店", "线上App", "小程序", "天猫旗舰店", "京东自营"]
CHANNEL_WEIGHTS = [0.34, 0.24, 0.18, 0.14, 0.10]
PAYMENTS = ["微信", "支付宝", "银行卡", "现金"]
PAYMENT_WEIGHTS = [0.38, 0.34, 0.18, 0.10]
DELIVERIES = ["自提", "快递", "同城配送"]
DELIVERY_WEIGHTS = [0.42, 0.40, 0.18]
DISCOUNTS = [0, 0, 0, 0.05, 0.1, 0.15, 0.2]

PRODUCTS = {
    "饮料": [("可乐 330ml", 3.5), ("矿泉水 550ml", 2.5), ("鲜榨果汁", 12.0), ("冷萃咖啡", 22.0)],
    "零食": [("原味薯片", 6.5), ("黄油饼干", 9.9), ("每日坚果", 25.0), ("黑巧克力", 15.0)],
    "生鲜": [("红富士苹果", 8.8), ("进口香蕉", 6.5), ("鲜牛奶 950ml", 15.0), ("土鸡蛋 10 枚", 12.8)],
    "日用": [("抽纸 3 包", 15.9), ("洗衣液 2L", 39.9), ("薄荷牙膏", 12.5)],
    "酒类": [("精酿啤酒", 9.9), ("赤霞珠红酒", 128.0), ("浓香白酒", 218.0)],
    "乳品": [("原味酸奶", 8.5), ("儿童奶酪", 29.9)],
}
COST_RATE = {"饮料": 0.58, "零食": 0.62, "生鲜": 0.70, "日用": 0.55, "酒类": 0.48, "乳品": 0.66}


def weighted(values, weights):
    return random.choices(values, weights=weights, k=1)[0]


def main(out_path):
    rows = []
    for _ in range(ROWS):
        store, city, _ = weighted(STORES, [s[2] for s in STORES])
        category = random.choices(list(PRODUCTS), weights=[0.26, 0.22, 0.20, 0.16, 0.10, 0.06], k=1)[0]
        product, unit_price = random.choice(PRODUCTS[category])
        quantity = random.randint(1, 5)
        discount = random.choice(DISCOUNTS)
        sales = round(quantity * unit_price * (1 - discount), 2)
        cost = round(quantity * unit_price * COST_RATE[category], 2)
        profit = round(sales - cost, 2)
        order_date = START + timedelta(days=random.randrange(DAYS))
        rows.append({
            "下单日期": order_date.isoformat(),
            "客户编号": f"C{random.randint(10000, 99999)}",
            "性别": random.choices(["男", "女", "未知"], weights=[0.48, 0.50, 0.02], k=1)[0] if random.random() > 0.01 else "",
            "年龄": random.randint(18, 65),
            "城市": city if random.random() > 0.005 else "",
            "门店": store,
            "渠道": weighted(CHANNELS, CHANNEL_WEIGHTS),
            "商品类别": category,
            "商品名称": product,
            "数量": quantity,
            "单价": unit_price,
            "折扣": discount,
            "销售额": sales,
            "成本": cost,
            "利润": profit,
            "支付方式": weighted(PAYMENTS, PAYMENT_WEIGHTS),
            "配送方式": weighted(DELIVERIES, DELIVERY_WEIGHTS),
            "评分": random.randint(1, 5) if random.random() > 0.04 else "",
        })
    rows.sort(key=lambda item: item["下单日期"])
    columns = ["订单编号", "下单日期", "客户编号", "性别", "年龄", "城市", "门店", "渠道",
               "商品类别", "商品名称", "数量", "单价", "折扣", "销售额", "成本", "利润",
               "支付方式", "配送方式", "评分"]
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for index, row in enumerate(rows, start=1):
            row["订单编号"] = f"ORD-2025-{index:05d}"
            writer.writerow(row)
    print(f"wrote {out}: {len(rows)} rows, {len(columns)} columns")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "examples/retail-orders.csv")
