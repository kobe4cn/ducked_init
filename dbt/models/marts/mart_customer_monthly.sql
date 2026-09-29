-- 客户 × 月 消费事实表（增量：每次只重算最近 2 个月）
{{ config(materialized='incremental', unique_key=['customer_id', 'order_month'], incremental_strategy='delete+insert') }}

select
    customer_id,
    order_month,
    count(*)             as orders,
    sum(net_amount)      as spend,
    {{ last_by('channel', 'order_ts') }} as last_channel
from {{ ref('stg_paid_orders') }}
{% if is_incremental() %}
where order_month >= (select max(order_month) from {{ this }}) - interval 1 month
{% endif %}
group by customer_id, order_month
