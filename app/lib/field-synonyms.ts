// app/lib/field-synonyms.ts —— 标准字段的列名同义词与枚举取值的近义词：按规则生成映射草稿时据此把源列对应到标准字段、预填值字典，
// 映射报错时也据此提示「这一列多半是哪个标准字段」。随标准模型（canonical-model.ts）一起维护，前后端共用（ADR-0017）
import { entityOf } from './canonical-model';

/** 列名规范化：驼峰拆开、忽略大小写，连字符、空白与连续下划线都当作一个下划线（OrderId、order-id、ORDER_ID 都是 order_id） */
export function normalizeName(s: string) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-\s_]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** 带单位的列名后缀：分（金额除以 100）与毫秒；对应字段时先去掉 */
export const CENTS_SUFFIX = /_(cents|fen)$/;
const UNIT_SUFFIX = /_(cents|fen|ms|millis)$/;

/** 多个实体共有的字段 */
const COMMON: Record<string, readonly string[]> = {
  customer_id: ['cust_id', 'user_id', 'uid', 'member_id', 'buyer_id', 'client_id', 'consumer_id'],
  order_id: ['order_no', 'order_sn', 'order_code', 'trade_no', 'tid'],
  product_id: ['sku', 'sku_id', 'sku_code', 'goods_id', 'item_id', 'spu_id'],
  updated_at: ['update_time', 'updated_time', 'modified_at', 'modify_time', 'gmt_modified', 'last_modified', 'mtime', 'updated'],
  created_at: ['create_time', 'created_time', 'gmt_create', 'ctime', 'created'],
};

/** 各实体字段的列名同义词（都是规范化后的写法）；按优先级排列 */
const COLUMN_SYNONYMS: Record<string, Record<string, readonly string[]>> = {
  customer: {
    customer_id: ['id', ...COMMON.customer_id],
    name: ['customer_name', 'user_name', 'real_name', 'full_name', 'nickname', 'nick_name'],
    phone: ['mobile', 'tel', 'phone_no', 'phone_number', 'mobile_no', 'mobile_phone', 'cellphone', 'telephone'],
    email: ['mail', 'email_address', 'e_mail'],
    gender: ['sex'],
    birthday: ['birth_date', 'birthdate', 'date_of_birth', 'dob', 'birth'],
    city: ['city_name'],
    registered_at: ['register_time', 'registered_time', 'reg_time', 'signup_at', 'signup_time', 'joined_at', ...COMMON.created_at, 'created_at'],
    updated_at: COMMON.updated_at,
  },
  order: {
    order_id: ['id', ...COMMON.order_id],
    customer_id: COMMON.customer_id,
    status: ['order_status', 'state', 'trade_status'],
    amount: ['pay_amount', 'paid_amount', 'payment', 'payment_amount', 'actual_amount', 'real_amount', 'total_amount', 'order_amount', 'total'],
    created_at: ['ordered_at', 'order_time', 'order_date', ...COMMON.created_at],
    paid_at: ['pay_time', 'paid_time', 'payment_time', 'pay_at'],
    channel: ['source', 'platform', 'order_channel', 'order_source'],
    store_id: ['shop_id', 'store_code', 'shop_code'],
    updated_at: COMMON.updated_at,
  },
  order_item: {
    order_item_id: ['id', 'item_id', 'line_id', 'order_line_id', 'detail_id'],
    order_id: COMMON.order_id,
    product_id: COMMON.product_id,
    quantity: ['qty', 'num', 'count', 'amount_qty', 'buy_num'],
    unit_price: ['price', 'sale_price', 'deal_price'],
    amount: ['pay_amount', 'line_amount', 'total_amount', 'subtotal', 'total'],
  },
  product: {
    product_id: ['id', ...COMMON.product_id],
    name: ['product_name', 'goods_name', 'item_name', 'title', 'sku_name'],
    category: ['category_name', 'cat', 'cate', 'category_id'],
    brand: ['brand_name'],
    price: ['list_price', 'sale_price', 'unit_price', 'tag_price'],
  },
  event: {
    event_id: ['id', 'log_id', 'track_id'],
    customer_id: COMMON.customer_id,
    device_id: ['device', 'distinct_id', 'anonymous_id', 'idfa', 'imei', 'cookie_id'],
    event_type: ['event', 'event_name', 'action', 'type', 'behavior'],
    occurred_at: ['occurred', 'occur_time', 'event_time', 'event_at', 'ts', 'timestamp', 'time', ...COMMON.created_at, 'created_at'],
    page: ['page_url', 'url', 'path', 'screen', 'page_name'],
  },
  touch: {
    touch_id: ['id', 'send_id', 'message_id', 'msg_id', 'record_id'],
    customer_id: COMMON.customer_id,
    campaign_id: ['activity_id', 'campaign', 'plan_id'],
    channel: ['send_channel', 'touch_channel', 'type'],
    status: ['send_status', 'state', 'result'],
    sent_at: ['send_time', 'sent_time', 'send_at', ...COMMON.created_at, 'created_at'],
  },
  membership: {
    membership_id: ['id', 'member_id', 'member_no', 'card_no', 'vip_no'],
    customer_id: ['cust_id', 'user_id', 'uid', 'buyer_id', 'consumer_id'],
    level: ['member_level', 'level_name', 'grade', 'vip_level', 'tier'],
    points: ['point', 'score', 'credit', 'credits', 'balance_points'],
    status: ['member_status', 'state'],
    joined_at: ['join_time', 'joined_time', 'register_time', 'open_time', ...COMMON.created_at, 'created_at'],
    expires_at: ['expire_time', 'expired_at', 'expiry_date', 'valid_until', 'end_time'],
  },
};

/** 标准枚举的取值近义词（比较时忽略大小写与首尾空白）：标准值本身不用列出 */
const VALUE_SYNONYMS: Record<string, Record<string, Record<string, readonly string[]>>> = {
  customer: {
    gender: {
      male: ['男', '男性', 'm', 'man', '先生'],
      female: ['女', '女性', 'f', 'woman', '女士'],
      unknown: ['未知', '保密', '其他', 'u', 'n/a', 'none', 'secret'],
    },
  },
  order: {
    status: {
      created: ['待支付', '待付款', '未支付', '未付款', '新建', '已下单', 'pending', 'unpaid', 'new', 'wait_pay'],
      paid: ['已支付', '已付款', '支付成功', '待发货', 'payed'],
      shipped: ['已发货', '发货', '配送中', '运输中', 'delivering', 'shipping'],
      completed: ['已完成', '完成', '已签收', '交易成功', 'complete', 'finished', 'done', 'success', 'received'],
      cancelled: ['已取消', '取消', '已关闭', '交易关闭', 'canceled', 'cancel', 'closed'],
      refunded: ['已退款', '退款', '退款成功', 'refund'],
    },
  },
  touch: {
    channel: {
      sms: ['短信', '短消息'],
      email: ['邮件', '电子邮件', 'mail', 'edm'],
      push: ['推送', 'app推送', '消息推送'],
      wechat: ['微信', 'wx', 'weixin', '公众号', '企业微信'],
      app: ['站内信', 'inapp', 'in_app'],
      other: ['其他', '其它'],
    },
    status: {
      sent: ['已发送', '发送成功', '发送'],
      delivered: ['已送达', '送达', '到达'],
      opened: ['已打开', '已读', '打开', 'read'],
      clicked: ['已点击', '点击', 'click'],
      failed: ['失败', '发送失败', 'fail', 'error'],
    },
  },
  membership: {
    status: {
      active: ['正常', '有效', '激活', '已激活', '生效', 'normal', 'valid', 'enabled'],
      frozen: ['冻结', '已冻结', 'freeze', 'locked'],
      expired: ['过期', '已过期', '失效', '已失效', 'expire'],
      cancelled: ['注销', '已注销', '取消', '已取消', 'canceled', 'closed'],
    },
  },
};

/** 列对应到字段的依据：同名（规范化后），或同义词 */
export type NameMatch = { field: string; by: 'same' | 'synonym'; rank: number };

/**
 * 源列按名称可能对应的标准字段（同名在前，同义词按优先级），列名先规范化，带单位后缀（_cents、_fen、_ms）的也试去掉后缀的写法。
 * 实体不认识时为空
 */
export function fieldsForColumn(entityName: string, column: string): NameMatch[] {
  const entity = entityOf(entityName);
  if (!entity) return [];
  const norm = normalizeName(column);
  const names = [...new Set([norm, norm.replace(UNIT_SUFFIX, '')])];
  const synonyms = COLUMN_SYNONYMS[entity.name] ?? {};
  const matches: NameMatch[] = [];
  for (const f of entity.fields) {
    if (names.includes(f.name)) { matches.push({ field: f.name, by: 'same', rank: 0 }); continue; }
    const i = (synonyms[f.name] ?? []).findIndex(s => names.includes(s));
    if (i >= 0) matches.push({ field: f.name, by: 'synonym', rank: i + 1 });
  }
  return matches.sort((a, b) => a.rank - b.rank);
}

/** 源端取值对应的标准枚举值：与标准值同名或在近义词表里；对不上（如纯数字编码）时为 undefined */
export function standardValue(entityName: string, fieldName: string, value: string) {
  const field = entityOf(entityName)?.fields.find(f => f.name === fieldName);
  if (!field?.enum) return undefined;
  const v = value.trim().toLowerCase();
  if (field.enum.includes(v)) return v;
  const synonyms = VALUE_SYNONYMS[entityName]?.[fieldName] ?? {};
  return field.enum.find(e => synonyms[e]?.some(s => s.toLowerCase() === v));
}
