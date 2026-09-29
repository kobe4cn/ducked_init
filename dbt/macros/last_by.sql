{# 可复用的 SQL 片段：取“按时间最后一次出现”的值，例如客户最近一单的渠道 #}
{% macro last_by(col, ts_col) -%}
    arg_max({{ col }}, {{ ts_col }})
{%- endmacro %}
