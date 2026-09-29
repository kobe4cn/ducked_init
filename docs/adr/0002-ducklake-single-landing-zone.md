# 业务数据只落 DuckLake，DuckDB 只做计算，平台 PG 只存元数据

业务数据可以落在 DuckDB 文件、平台 PostgreSQL 或 S3 三处，但三处并存意味着三套权限与一致性问题。决定：业务数据唯一落点是 DuckLake（数据文件在对象存储，catalog 在平台 PostgreSQL）；DuckDB 只作为用完即弃的计算引擎，不持久化数据；平台 PostgreSQL 只存元数据（租户、成员、权限、数据源、映射与定义版本、任务、DuckLake catalog）。面向接口的服务库是从结果层派生的只读副本，可随时重建。
