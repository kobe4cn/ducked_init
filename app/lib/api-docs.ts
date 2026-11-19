// app/lib/api-docs.ts —— 外部接口登记表：API Key 页「接口说明」标签页按它渲染 /api/v1/ 下全部接口的调用方式，
// 内容（方法、路径、用途、鉴权、参数、成功响应示例、错误、curl）与各路由文件、ADR-0033 / 0040 / 0041 的行为一致。
// route 与 file 和 app/routes.ts 里的注册一一对应，test/api-docs.test.ts 双向比对：以后加接口漏登记、删接口忘删条目，测试都会失败。
// 示例里不出现任何真实 Key、哈希或租户数据：Key 与地址一律写占位符 <你的 API Key>、<平台地址>（不用 linkOrigin()，生产没配 APP_ORIGIN 时它会抛错）。
// 只能 import app/lib 里的东西（客户端组件要导入它，.server 的只能 import type，见 tag-vocab.ts 头注释）

/** 一个参数：在路径、查询串还是请求体里 */
export interface ApiEndpointParam {
  name: string;
  in: 'path' | 'query' | 'body';
  required: boolean;
  desc: string;
}

/** 一个错误：HTTP 状态码、返回的文案（error 字段）与什么时候出现 */
export interface ApiEndpointError {
  status: number;
  message: string;
  meaning: string;
}

/** 登记表的一项：一个外部接口 */
export interface ApiEndpoint {
  method: 'GET' | 'POST';
  /** 页面上显示的路径，路径参数写成 <说明> */
  path: string;
  /** app/routes.ts 里注册的路径（含 :参数名），扫描测试按它比对 */
  route: string;
  /** 路由文件（app/routes/ 下，带 routes/ 前缀） */
  file: string;
  purpose: string;
  auth: string;
  params: readonly ApiEndpointParam[];
  responseExample: string;
  errors: readonly ApiEndpointError[];
  curl: string;
}

/** Key 缺失、错误、已吊销或租户已暂停：一律 401，响应相同不区分原因（api-auth.ts） */
const UNAUTHORIZED: ApiEndpointError = {
  status: 401,
  message: '未授权：请在 Authorization 头里带上有效的 API Key（Bearer）',
  meaning: '没带 Key、Key 错误、Key 已吊销或租户已暂停，响应一律相同，并带 WWW-Authenticate: Bearer',
};

/** 点查接口共同的 503：还没有服务库、正在生成或数据湖未初始化 */
const SERVING_UNAVAILABLE: ApiEndpointError = {
  status: 503,
  message: '本租户还没有服务库，请稍后再试 / 本租户的服务库暂时不可用，请稍后再试 / 本租户的数据湖还没有初始化',
  meaning: '本租户还没有任何已发布的结果，或服务库正在生成，稍后重试',
};

/** 点查两个接口共同的说明：响应字段（serving-reader.ts 的 ConsumerProfile，示例里挑了有代表性的值） */
const PROFILE_EXAMPLE = `{
  "consumer_id": "9f0c4d2a-6b1e-4c7a-a2f3-1d5e8b9c0a41",
  "requested_id": "9f0c4d2a-6b1e-4c7a-a2f3-1d5e8b9c0a41",
  "serving_version": 3,
  "tags": { "value_tier": "high" },
  "metrics": {
    "revenue": [{ "dims": {}, "value": 1280.5 }],
    "revenue_by_city": [{ "dims": { "city": "上海" }, "value": 860.0 }]
  },
  "rfm": { "segment": "champion", "r": 5, "f": 4, "m": 5, "recency_days": 6, "frequency": 12, "monetary": "1280.50" },
  "snapshots": [{ "id": "3b8e…", "template": "tag:value_tier", "definitionVersion": 1, "createdAt": "2026-11-15T02:00:00.000Z", "incomplete": false }]
}`;

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/api/v1/catalog',
    route: 'api/v1/catalog',
    file: 'routes/api.v1.catalog.tsx',
    purpose: '本租户已发布的指标与标签目录：各自的键、当前版本（最新已发布版）、说明、业务知识里的说明（note）与发布时间。只列已发布的，草稿不出现。',
    auth: 'Authorization: Bearer <你的 API Key>',
    params: [],
    responseExample: `{
  "definitions": [
    { "kind": "metric", "key": "revenue", "version": 2, "description": "累计消费金额", "note": "财务口径：只算已支付、已发货或已完成，已退款整单不计", "publishedAt": "2026-11-01T08:30:00.000Z" },
    { "kind": "tag", "key": "value_tier", "version": 1, "description": null, "note": null, "publishedAt": "2026-11-01T09:00:00.000Z" }
  ]
}`,
    errors: [UNAUTHORIZED],
    curl: `curl -H 'Authorization: Bearer <你的 API Key>' '<平台地址>/api/v1/catalog'`,
  },
  {
    method: 'GET',
    path: '/api/v1/consumers/<ID>',
    route: 'api/v1/consumers/:consumerId',
    file: 'routes/api.v1.consumers.$id.tsx',
    purpose: '按统一消费者 ID 点查这个人的标签、指标与 RFM。不填 ?snapshot= 时读本租户当前的服务库（最新的已发布结果）。',
    auth: 'Authorization: Bearer <你的 API Key>',
    params: [
      { name: 'consumerId', in: 'path', required: true, desc: '统一消费者 ID（超过 256 字符的当作查无此人，返回 404）' },
      { name: 'snapshot', in: 'query', required: false, desc: '快照 ID。给了就只读那一张快照表（RFM、指标或标签的），此时 serving_version 为 null；不给读当前服务库' },
    ],
    responseExample: PROFILE_EXAMPLE,
    errors: [
      UNAUTHORIZED,
      { status: 404, message: '没有这个消费者', meaning: '统一消费者 ID 不存在' },
      { status: 404, message: '快照不存在或已过期', meaning: '?snapshot= 给的快照不存在、已过期，或不是 RFM / 指标 / 标签的快照' },
      SERVING_UNAVAILABLE,
    ],
    curl: `curl -H 'Authorization: Bearer <你的 API Key>' '<平台地址>/api/v1/consumers/9f0c4d2a-6b1e-4c7a-a2f3-1d5e8b9c0a41'`,
  },
  {
    method: 'GET',
    path: '/api/v1/consumers/by-source/<数据源登记名>/<源端 ID>',
    route: 'api/v1/consumers/by-source/:source/:customerId',
    file: 'routes/api.v1.consumers.by-source.tsx',
    purpose: '按业务系统自己的 ID 点查：给数据源登记名与这个数据源里的源端消费者 ID，响应与按统一消费者 ID 点查完全相同（requested_id 是源端 ID）。',
    auth: 'Authorization: Bearer <你的 API Key>',
    params: [
      { name: 'source', in: 'path', required: true, desc: '数据源登记名，按原样比较、区分大小写，调用时要 URL 编码（如「会员」写成 %E4%BC%9A%E5%91%98）' },
      { name: 'customerId', in: 'path', required: true, desc: '这个数据源里的源端消费者 ID，同样要 URL 编码（带 / 或空格时也编成 %2F、%20）' },
    ],
    responseExample: PROFILE_EXAMPLE,
    errors: [
      UNAUTHORIZED,
      { status: 400, message: '按数据源查询不支持 snapshot：请先查出 consumer_id，再带 snapshot 调 /api/v1/consumers/:consumerId', meaning: '这个接口不接受 ?snapshot=（旧快照记的是当时的 ID）' },
      { status: 404, message: '没有这个数据源', meaning: '数据源登记名不存在（区分大小写）' },
      { status: 404, message: '这个数据源下没有这个消费者', meaning: '源端 ID 不存在，或查到人但他没有任何标签、指标与 RFM 结果' },
      SERVING_UNAVAILABLE,
    ],
    curl: `curl -H 'Authorization: Bearer <你的 API Key>' '<平台地址>/api/v1/consumers/by-source/crm/10086'`,
  },
  {
    method: 'POST',
    path: '/api/v1/exports',
    route: 'api/v1/exports',
    file: 'routes/api.v1.exports.tsx',
    purpose: '按 1–5 个标签条件发起一次人群导出，异步执行。响应 202 带导出 ID 与每个标签所用的快照 ID，之后凭导出 ID 轮询状态。',
    auth: 'Authorization: Bearer <你的 API Key>',
    params: [
      { name: 'conditions', in: 'body', required: true, desc: '1 到 5 个 { "tag": 标签键, "value": 取值 }；标签键不能重复，取值是 1–200 字符的字符串' },
      { name: 'snapshots', in: 'body', required: false, desc: '{ <条件里的标签>: <快照 ID> }：指定某个标签用哪张快照，只能给条件里出现过的标签；不给时用最新的未过期快照' },
      { name: 'format', in: 'body', required: false, desc: "'parquet'（默认）或 'csv'" },
    ],
    responseExample: `202
{
  "id": "0d1e2f3a-4b5c-6d7e-8f9a-0b1c2d3e4f5a",
  "status": "queued",
  "snapshots": { "value_tier": "3b8e1c2d-…" }
}`,
    errors: [
      UNAUTHORIZED,
      { status: 400, message: '请求体必须是 JSON / 请求体必须是 JSON 对象', meaning: '请求体不是合法 JSON，或不是 JSON 对象' },
      { status: 400, message: 'conditions 必须是 1 到 5 个 { tag, value }、标签 × 重复、标签键不合法、取值为空或超长、snapshots 不合法、format 不合法、标签 × 还没有可用的快照、标签 × 指定的快照不存在、已过期或不是这个标签的', meaning: '条件或快照不合法，不入队、不记审计；错误文案里 × 是具体的标签键' },
      { status: 405, message: '只支持 POST', meaning: '用别的方法调这个路径' },
    ],
    curl: `curl -X POST -H 'Authorization: Bearer <你的 API Key>' -H 'Content-Type: application/json' \\
  -d '{"conditions":[{"tag":"value_tier","value":"high"}]}' \\
  '<平台地址>/api/v1/exports'`,
  },
  {
    method: 'GET',
    path: '/api/v1/exports/<ID>',
    route: 'api/v1/exports/:id',
    file: 'routes/api.v1.exports.$id.tsx',
    purpose: '查一次人群导出的状态。成功且文件还在保留期（结束 24 小时）内时，每次查询都签发一个新的 15 分钟下载链接；过了保留期状态变为 expired、没有链接。',
    auth: 'Authorization: Bearer <你的 API Key>',
    params: [
      { name: 'id', in: 'path', required: true, desc: '发起导出时返回的导出 ID（就是任务 ID）' },
    ],
    responseExample: `{
  "id": "0d1e2f3a-4b5c-6d7e-8f9a-0b1c2d3e4f5a",
  "status": "succeeded",
  "format": "parquet",
  "snapshots": { "value_tier": "3b8e1c2d-…" },
  "rowCount": 1520,
  "download": { "url": "/api/v1/exports/<导出 ID>/download?token=…", "expiresAt": "2026-11-16T10:15:00.000Z" }
}`,
    errors: [
      UNAUTHORIZED,
      { status: 404, message: '导出不存在', meaning: '导出 ID 不是 UUID、不存在、属于别的租户，或这个任务不是人群导出' },
    ],
    curl: `curl -H 'Authorization: Bearer <你的 API Key>' '<平台地址>/api/v1/exports/0d1e2f3a-4b5c-6d7e-8f9a-0b1c2d3e4f5a'`,
  },
  {
    method: 'GET',
    path: '/api/v1/exports/<ID>/download?token=',
    route: 'api/v1/exports/:id/download',
    file: 'routes/api.v1.exports.$id.download.tsx',
    purpose: '下载导出文件（Parquet 或 CSV，与发起时的 format 一致）。凭下载链接里的令牌，不用（也不认）Bearer Key。',
    auth: '不用 Bearer：只认链接里的 ?token=（由「查导出状态」返回的 download.url 带来）',
    params: [
      { name: 'id', in: 'path', required: true, desc: '导出 ID' },
      { name: 'token', in: 'query', required: true, desc: '下载令牌，在 download.url 里；链接 15 分钟内有效，过期后重新查询导出状态拿新的' },
    ],
    responseExample: `导出文件本体（Parquet：application/vnd.apache.parquet，CSV：text/csv），
响应头 Content-Disposition: attachment; filename="export-<导出 ID>.<格式>"`,
    errors: [
      { status: 404, message: '下载链接不存在', meaning: '没带 token、令牌不对，或令牌不属于这个导出' },
      { status: 410, message: '下载链接已过期，请重新查询导出状态获取新链接', meaning: '令牌过了 15 分钟、文件过了保留期（24 小时）或文件已被清理' },
    ],
    curl: `curl -L -o export.parquet '<平台地址>/api/v1/exports/<导出 ID>/download?token=<下载令牌>'`,
  },
];
