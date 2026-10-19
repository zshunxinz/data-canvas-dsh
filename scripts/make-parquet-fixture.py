"""生成一个用于验收的 Parquet 样本（需要 pyarrow）。

用法：
    python scripts/make-parquet-fixture.py out.parquet

覆盖：date32、timestamp(ms)、int32、超出安全范围的 int64、decimal、布尔、
中文文本、空值、list/struct/map 嵌套列、多个 row group。
"""
import datetime
import decimal
import sys

import pyarrow as pa
import pyarrow.parquet as pq

rows = [
    {
        "下单日期": datetime.date(2024, 1, 2),
        "下单时间": datetime.datetime(2024, 1, 2, 8, 30, 0),
        "数量": 3,
        "大整数": 2 ** 60 + 1,
        "单价": decimal.Decimal("12.50"),
        "是否加急": True,
        "客户": "张三",
        "备注": None,
        "标签": [1, 2],
        "地址": {"城市": "杭州", "评分": 4.5},
        "渠道": {"线上": 10},
    },
    {
        "下单日期": datetime.date(2024, 1, 3),
        "下单时间": datetime.datetime(2024, 1, 3, 17, 5, 30),
        "数量": 7,
        "大整数": 2 ** 61,
        "单价": decimal.Decimal("9.90"),
        "是否加急": False,
        "客户": "李四",
        "备注": "加急单",
        "标签": [],
        "地址": {"城市": "上海", "评分": 3.0},
        "渠道": {"线下": 5},
    },
    {
        "下单日期": datetime.date(2024, 2, 1),
        "下单时间": datetime.datetime(2024, 2, 1, 9, 0, 0),
        "数量": None,
        "大整数": None,
        "单价": decimal.Decimal("100.00"),
        "是否加急": True,
        "客户": "王五",
        "备注": None,
        "标签": [9],
        "地址": {"城市": "北京", "评分": 5.0},
        "渠道": {"线上": 1},
    },
]

schema = pa.schema([
    ("下单日期", pa.date32()),
    ("下单时间", pa.timestamp("ms")),
    ("数量", pa.int32()),
    ("大整数", pa.int64()),
    ("单价", pa.decimal128(10, 2)),
    ("是否加急", pa.bool_()),
    ("客户", pa.string()),
    ("备注", pa.string()),
    ("标签", pa.list_(pa.int32())),
    ("地址", pa.struct([("城市", pa.string()), ("评分", pa.float64())])),
    ("渠道", pa.map_(pa.string(), pa.int32())),
])

out = sys.argv[1] if len(sys.argv) > 1 else "sample.parquet"
table = pa.Table.from_pylist(rows, schema=schema)
pq.write_table(table, out, row_group_size=2)
print(f"wrote {out}: {pq.read_metadata(out).num_rows} rows, {pq.read_metadata(out).num_row_groups} row groups")
