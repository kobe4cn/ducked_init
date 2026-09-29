-- RFM 人群 KPI（近 90 天），给 BI 直接用
with recent as (
    select customer_id, sum(spend) as spend_90d, sum(orders) as orders_90d
    from {{ ref('mart_customer_monthly') }}
    where order_month >= date_trunc('month', date '2026-09-27') - interval 2 month
    group by customer_id
)
select
    r.segment,
    count(*)                                      as customers,
    count(recent.customer_id)                     as active_90d,
    round(100.0 * count(recent.customer_id) / count(*), 1) as active_rate_pct,
    round(coalesce(sum(recent.spend_90d), 0))     as gmv_90d
from {{ source('gold', 'rfm') }} r
left join recent using (customer_id)
group by r.segment
order by gmv_90d desc
