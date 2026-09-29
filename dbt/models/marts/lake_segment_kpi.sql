-- 同样的结果直接写成湖上的 Parquet 文件（dbt-duckdb 的 external 物化）
{{ config(materialized='external', location="{{ env_var('DBT_LAKE_DIR', '../data/lake_out') }}/segment_kpi.parquet", format='parquet') }}
select * from {{ ref('mart_segment_kpi') }}
