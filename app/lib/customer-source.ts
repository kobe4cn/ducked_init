// app/lib/customer-source.ts —— 跨源引用（ADR-0030）：标准层里指向 customer 的引用列旁边记下目标消费者所在的数据源。前后端共用。

/** 引用列对应的数据源列：customer_id → _customer_source，其他（自定义关系、扩展字段）→ _<字段>_source */
export const customerSourceColumn = (field: string) => (field === 'customer_id' ? '_customer_source' : `_${field}_source`);
