-- 已支付订单：统一口径的起点，其他模型都从这里读
select
    order_id,
    customer_id,
    channel,
    order_ts,
    date_trunc('month', order_ts)::date as order_month,
    net_amount
from {{ source('silver', 'orders_clean') }}
where status = 'paid'
