// app/lib/field-synonyms.ts —— 标准字段的列名同义词与枚举取值的近义词：按规则生成映射草稿时据此把源列对应到标准字段、预填值字典，
// 新建映射时按表名猜目标实体，映射报错时也据此提示「这一列多半是哪个标准字段」；没用到的源列据规范化的列名起扩展字段名。随标准模型（canonical-model.ts）一起维护，前后端共用（ADR-0017）
import { CANONICAL_ENTITIES, entityOf, EXTENSION_PATTERN } from './canonical-model';

/** 列名规范化：驼峰拆开、忽略大小写，连字符、空白与连续下划线都当作一个下划线（OrderId、order-id、ORDER_ID 都是 order_id） */
export function normalizeName(s: string) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-\s_]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** 源列做成扩展字段时的名字：x_<规范化的列名>；做不成（中文、特殊字符）或已被占用时用 x_col_<列序号，从 1 起>，它也被占用时再加 _2、_3…。草稿与映射表单共用 */
export function extensionName(column: string, position: number, taken: Iterable<string>) {
  const used = new Set(taken);
  const name = `x_${normalizeName(column)}`;
  if (new RegExp(EXTENSION_PATTERN).test(name) && !used.has(name)) return name;
  let fallback = `x_col_${position}`;
  for (let n = 2; used.has(fallback); n++) fallback = `x_col_${position}_${n}`;
  return fallback;
}

/** 带单位的列名后缀：分（金额除以 100）与毫秒；对应字段时先去掉 */
export const CENTS_SUFFIX = /_(cents|fen)$/;
const UNIT_SUFFIX = /_(cents|fen|ms|millis)$/;

/** 多个实体共有的字段 */
const COMMON: Record<string, readonly string[]> = {
  customer_id: ['cust_id', 'user_id', 'uid', 'member_id', 'buyer_id', 'client_id', 'consumer_id'],
  /** 带会员号的表里 member_id 是会员号，不当消费者 ID */
  member_customer_id: ['cust_id', 'user_id', 'uid', 'buyer_id', 'consumer_id'],
  order_id: ['order_no', 'order_sn', 'order_code', 'trade_no', 'tid'],
  product_id: ['sku', 'sku_id', 'sku_code', 'goods_id', 'item_id', 'spu_id'],
  updated_at: ['update_time', 'updated_time', 'modified_at', 'modify_time', 'gmt_modified', 'last_modified', 'mtime', 'updated'],
  created_at: ['create_time', 'created_time', 'gmt_create', 'ctime', 'created'],
};

/** 营销渠道的取值近义词：营销触达与营销同意共用 */
const CHANNEL_VALUES: Record<string, readonly string[]> = {
  sms: ['短信', '短消息'],
  email: ['邮件', '电子邮件', 'mail', 'edm'],
  push: ['推送', 'app推送', '消息推送'],
  wechat: ['微信', 'wx', 'weixin', '公众号', '企业微信'],
  app: ['站内信', 'inapp', 'in_app'],
  other: ['其他', '其它'],
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
    customer_id: COMMON.member_customer_id,
    level: ['member_level', 'level_name', 'grade', 'vip_level', 'tier'],
    points: ['point', 'score', 'credit', 'credits', 'balance_points'],
    status: ['member_status', 'state'],
    joined_at: ['join_time', 'joined_time', 'register_time', 'open_time', ...COMMON.created_at, 'created_at'],
    expires_at: ['expire_time', 'expired_at', 'expiry_date', 'valid_until', 'end_time'],
  },
  points_transaction: {
    points_transaction_id: ['id', 'transaction_id', 'txn_id', 'log_id', 'flow_id', 'record_id', 'serial_no', 'points_log_id', 'point_log_id'],
    membership_id: ['member_id', 'member_no', 'card_no', 'vip_no', 'membership_no'],
    customer_id: COMMON.member_customer_id,
    change_type: ['type', 'points_type', 'point_type', 'trans_type', 'transaction_type', 'biz_type', 'action'],
    points_change: ['points', 'point', 'change_points', 'change_point', 'points_delta', 'delta', 'change_amount', 'change_value', 'score'],
    balance_after: ['balance', 'points_balance', 'point_balance', 'after_balance', 'balance_points', 'remain_points', 'left_points'],
    order_id: COMMON.order_id,
    occurred_at: ['occurred', 'occur_time', 'trans_time', 'transaction_time', 'change_time', 'event_time', ...COMMON.created_at, 'created_at'],
    expires_at: ['expire_time', 'expired_at', 'expire_at', 'expiry_time', 'expiry_date', 'expire_date', 'valid_until', 'end_time'],
  },
  consent: {
    customer_id: COMMON.customer_id,
    channel: ['consent_channel', 'subscribe_channel', 'channel_type', 'send_channel', 'touch_channel'],
    status: ['consent_status', 'opt_in', 'optin', 'opt_status', 'subscribe_status', 'subscribed', 'is_subscribed', 'agreed', 'is_agreed', 'consent', 'state'],
    granted_at: ['grant_time', 'granted_time', 'consent_time', 'consented_at', 'agree_time', 'agreed_at', 'opt_in_time', 'opt_in_at', 'subscribe_time', 'subscribed_at'],
    revoked_at: ['revoke_time', 'revoked_time', 'withdraw_time', 'withdrawn_at', 'opt_out_time', 'opt_out_at', 'unsubscribe_time', 'unsubscribed_at'],
    updated_at: COMMON.updated_at,
  },
  preference: {
    customer_id: COMMON.customer_id,
    preference_type: ['pref_type', 'preference_key', 'pref_key', 'interest_type', 'type', 'key'],
    preference_value: ['pref_value', 'interest_value', 'pref', 'interest', 'preference', 'value'],
    updated_at: COMMON.updated_at,
  },
  coupon: {
    coupon_id: ['id', 'coupon_code', 'code', 'coupon_no', 'coupon_sn', 'user_coupon_id'],
    coupon_template_id: ['template_id', 'tpl_id', 'coupon_tpl_id', 'batch_id', 'batch_no', 'coupon_batch_id', 'stock_id'],
    campaign_id: ['activity_id', 'campaign', 'plan_id', 'act_id', 'promotion_id'],
    customer_id: COMMON.customer_id,
    status: ['coupon_status', 'use_status', 'state'],
    issued_at: ['issue_time', 'issued_time', 'receive_time', 'received_at', 'get_time', 'grant_time', 'send_time', ...COMMON.created_at, 'created_at'],
    redeemed_at: ['redeem_time', 'redeemed_time', 'use_time', 'used_time', 'used_at', 'verify_time', 'verified_at', 'write_off_time', 'consume_time'],
    order_id: [...COMMON.order_id, 'use_order_id', 'use_order_no', 'used_order_id', 'redeem_order_id'],
    discount_amount: ['discount', 'deduct_amount', 'deduction', 'discount_value', 'coupon_discount', 'off_amount', 'used_amount'],
    expires_at: ['expire_time', 'expired_at', 'expire_at', 'expiry_time', 'expiry_date', 'expire_date', 'valid_until', 'valid_end', 'end_time'],
    updated_at: COMMON.updated_at,
  },
  coupon_template: {
    coupon_template_id: ['id', 'template_id', 'tpl_id', 'coupon_tpl_id', 'batch_id', 'batch_no', 'coupon_batch_id', 'stock_id'],
    name: ['coupon_name', 'template_name', 'title', 'batch_name'],
    coupon_type: ['type', 'template_type', 'coupon_kind', 'kind'],
    face_value: ['denomination', 'par_value', 'face_amount', 'coupon_amount', 'reduce_amount', 'value', 'amount'],
    pay_percent: ['pay_rate', 'pay_ratio', 'payable_percent', 'payable_rate'],
    min_spend: ['threshold', 'min_amount', 'min_consume', 'min_order_amount', 'use_threshold', 'condition_amount', 'full_amount'],
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
    channel: CHANNEL_VALUES,
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
  points_transaction: {
    change_type: {
      earn: ['获得', '获取', '发放', '赠送', '奖励', '累积', '增加', '购物获得', '消费获得', 'earned', 'gain', 'add', 'reward', 'issue'],
      spend: ['消费', '抵扣', '积分抵扣', '抵现', '使用', 'spent', 'use', 'consume', 'deduct'],
      redeem: ['兑换', '积分兑换', '兑礼', 'exchange', 'redemption'],
      expire: ['过期', '到期', '失效', '过期清零', 'expired'],
      adjust: ['调整', '人工调整', '手动调整', '冲回', '退款冲回', '退回', '修正', 'adjustment', 'manual', 'refund', 'rollback'],
    },
  },
  consent: {
    channel: CHANNEL_VALUES,
    status: {
      granted: ['同意', '已同意', '订阅', '已订阅', '授权', '已授权', '允许', '接受', 'y', 'yes', 'true', 'opt_in', 'optin', 'subscribed', 'agree', 'agreed', 'accepted', 'allow'],
      revoked: ['撤回', '已撤回', '拒绝', '已拒绝', '不同意', '退订', '已退订', '取消订阅', '取消授权', 'n', 'no', 'false', 'opt_out', 'optout', 'unsubscribed', 'withdrawn', 'declined', 'refused', 'rejected', 'deny'],
    },
  },
  coupon: {
    status: {
      issued: ['未使用', '待使用', '可使用', '可用', '已发放', '已领取', '未核销', 'unused', 'available', 'received', 'active', 'valid'],
      redeemed: ['已使用', '已核销', '使用', '核销', 'used', 'redeem', 'consumed', 'verified', 'written_off'],
      expired: ['已过期', '过期', '已失效', '失效', 'expire', 'overdue'],
      voided: ['已作废', '作废', '已撤销', '撤销', '已回收', '回收', 'void', 'invalid', 'revoked', 'cancelled', 'canceled', 'disabled'],
    },
  },
  coupon_template: {
    coupon_type: {
      cash: ['代金', '代金券', '满减', '满减券', '现金券', '立减', '立减券', 'voucher', 'cash_coupon', 'reduce', 'full_reduction'],
      discount: ['折扣', '折扣券', '打折', '打折券', 'discount_coupon', 'percent_off'],
      gift: ['赠品', '赠品券', '兑换', '兑换券', '礼品券', 'gift_coupon', 'exchange'],
      shipping: ['免运费', '免运费券', '运费券', '包邮', '包邮券', '免邮', 'free_shipping', 'freight'],
      other: ['其他', '其它'],
    },
  },
};

/** 列对应到字段的依据：同名（规范化后），或同义词 */
export type NameMatch = { field: string; by: 'same' | 'synonym'; rank: number };

/**
 * 源列按名称可能对应的标准字段（同名在前，同义词按优先级），列名先规范化，带单位后缀（_cents、_fen、_ms）的也试去掉后缀的写法，
 * 以 _ts 结尾的也试 _time 与 _at 的写法（order_ts 即 order_time）。
 * 实体不认识时为空
 */
export function fieldsForColumn(entityName: string, column: string): NameMatch[] {
  const entity = entityOf(entityName);
  if (!entity) return [];
  const norm = normalizeName(column);
  const bare = norm.replace(UNIT_SUFFIX, '');
  const names = [...new Set([norm, bare, ...(/_ts$/.test(bare) ? [bare.replace(/_ts$/, '_time'), bare.replace(/_ts$/, '_at')] : [])])];
  const synonyms = COLUMN_SYNONYMS[entity.name] ?? {};
  const matches: NameMatch[] = [];
  for (const f of entity.fields) {
    if (names.includes(f.name)) { matches.push({ field: f.name, by: 'same', rank: 0 }); continue; }
    const i = (synonyms[f.name] ?? []).findIndex(s => names.includes(s));
    if (i >= 0) matches.push({ field: f.name, by: 'synonym', rank: i + 1 });
  }
  return matches.sort((a, b) => a.rank - b.rank);
}

/** 表名对应的标准实体：规范化、去掉 t_ / tb_ 前缀后与实体同名，或是实体名的复数（orders、order_items）；认不出时为 undefined */
export function entityForTable(table: string) {
  const name = normalizeName(table).replace(/^tb?_/, '');
  return CANONICAL_ENTITIES.find(e => [e.name, `${e.name}s`, `${e.name}es`].includes(name));
}

/** 编辑距离（插入、删除、替换各算一步） */
function distance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * 候选里与 name 相近的名字（多半是拼错了）：规范化后编辑距离不超过名字长度的四分之一（至少 1、至多 2），近的在前
 */
export function similarNames(name: string, candidates: readonly string[]): string[] {
  const norm = normalizeName(name);
  const limit = Math.min(2, Math.max(1, Math.floor(norm.length / 4)));
  return candidates
    .map(c => ({ c, d: distance(norm, c) }))
    .filter(({ d }) => d > 0 && d <= limit)
    .sort((a, b) => a.d - b.d)
    .map(({ c }) => c);
}

/** 实体里与 name 相近的标准字段（映射报错时提示「是不是想写」）；实体不认识时为空 */
export function similarFields(entityName: string, name: string): string[] {
  return similarNames(name, entityOf(entityName)?.fields.map(f => f.name) ?? []);
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
