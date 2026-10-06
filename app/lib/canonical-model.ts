// app/lib/canonical-model.ts —— 平台内置的标准模型（Canonical Model）：一组标准实体及其字段，所有指标与标签只基于它定义。
// 同一大版本内只做新增（新增实体、字段、标准枚举取值），不改名、不改语义、不改类型、不改已有实体的主键；每次新增小版本加一（ADR-0018）。
// 映射里的 model 写的是大版本号。前后端共用（标准模型页要展示实体与字段说明）
export const MODEL_VERSION = '1.5';
export const MODEL_MAJOR = 1;

/** 字段类型：标准层里的列类型由它决定（时间一律是带时区的时间，按 UTC 存放；金额是两位小数的元） */
export const FIELD_TYPES = {
  string: { label: '文本', sql: 'VARCHAR' },
  integer: { label: '整数', sql: 'BIGINT' },
  decimal: { label: '小数（两位）', sql: 'DECIMAL(18, 2)' },
  timestamp: { label: '时间（UTC）', sql: 'TIMESTAMPTZ' },
  date: { label: '日期', sql: 'DATE' },
  boolean: { label: '布尔', sql: 'BOOLEAN' },
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
export const FIELD_TYPE_NAMES = Object.keys(FIELD_TYPES) as FieldType[];

export interface CanonicalField {
  name: string;
  type: FieldType;
  label: string;
  description: string;
  /** 标准枚举：取值只能是其中之一，源端的取值用值字典对应过来 */
  enum?: readonly string[];
  /** 敏感信息：标准层及之后只存按租户加盐的哈希（ADR-0005） */
  pii?: true;
  /** 关联：这个字段指向另一个标准实体的哪个字段（指向 customer 的在标准层经 silver._identities 关联，ADR-0019） */
  ref?: { entity: string; field: string };
}

export interface CanonicalEntity {
  name: string;
  label: string;
  description: string;
  /** 实体的主键字段：映射没有声明去重键时按它去重 */
  key: readonly string[];
  fields: readonly CanonicalField[];
}

/** 营销渠道：营销触达与营销同意共用一套，加渠道时两边一起加（ADR-0018） */
export const CHANNELS = ['sms', 'email', 'push', 'wechat', 'app', 'other'] as const;

const f = (name: string, type: FieldType, label: string, description: string, extra: Partial<CanonicalField> = {}): CanonicalField =>
  ({ name, type, label, description, ...extra });

export const CANONICAL_ENTITIES: readonly CanonicalEntity[] = [
  {
    name: 'customer',
    label: '消费者',
    description: '租户 CRM 数据中的终端客户，是指标与标签的计算对象。',
    key: ['customer_id'],
    fields: [
      f('customer_id', 'string', '消费者 ID', '源端的消费者标识（在一个数据源内唯一）'),
      f('name', 'string', '姓名', '消费者姓名', { pii: true }),
      f('phone', 'string', '手机号', '手机号', { pii: true }),
      f('email', 'string', '邮箱', '邮箱地址', { pii: true }),
      f('external_id', 'string', '外部 ID', '跨系统通用的消费者标识（如微信 unionid、集团会员号），身份打通按它精确匹配', { pii: true }),
      f('gender', 'string', '性别', '性别', { enum: ['male', 'female', 'unknown'] }),
      f('birthday', 'date', '生日', '出生日期'),
      f('city', 'string', '城市', '常住或注册城市'),
      f('registered_at', 'timestamp', '注册时间', '成为消费者（注册、首次留资）的时间'),
      f('updated_at', 'timestamp', '更新时间', '源端最后一次修改这条记录的时间'),
    ],
  },
  {
    name: 'order',
    label: '订单',
    description: '消费者的一笔交易。金额以元计。',
    key: ['order_id'],
    fields: [
      f('order_id', 'string', '订单 ID', '源端的订单号'),
      f('customer_id', 'string', '消费者 ID', '下单的消费者，对应消费者的 customer_id', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('status', 'string', '订单状态', '订单的当前状态', { enum: ['created', 'paid', 'shipped', 'completed', 'cancelled', 'refunded'] }),
      f('amount', 'decimal', '实付金额', '消费者实际支付的金额（元）'),
      f('created_at', 'timestamp', '下单时间', '订单创建的时间'),
      f('paid_at', 'timestamp', '支付时间', '订单支付的时间，未支付为空'),
      f('channel', 'string', '渠道', '下单渠道（如门店、小程序、天猫）'),
      f('store_id', 'string', '门店 ID', '成交门店，线上订单可为空'),
      f('updated_at', 'timestamp', '更新时间', '源端最后一次修改这条记录的时间'),
    ],
  },
  {
    name: 'order_item',
    label: '订单明细',
    description: '订单中的一个商品行。金额以元计。',
    key: ['order_item_id'],
    fields: [
      f('order_item_id', 'string', '明细 ID', '源端的订单明细标识'),
      f('order_id', 'string', '订单 ID', '所属订单，对应订单的 order_id', { ref: { entity: 'order', field: 'order_id' } }),
      f('product_id', 'string', '商品 ID', '购买的商品，对应商品的 product_id', { ref: { entity: 'product', field: 'product_id' } }),
      f('quantity', 'integer', '数量', '购买件数'),
      f('unit_price', 'decimal', '单价', '成交单价（元）'),
      f('amount', 'decimal', '金额', '这一行的实付金额（元）'),
    ],
  },
  {
    name: 'product',
    label: '商品',
    description: '租户售卖的商品（SKU）。',
    key: ['product_id'],
    fields: [
      f('product_id', 'string', '商品 ID', '源端的商品或 SKU 标识'),
      f('name', 'string', '商品名称', '商品名称'),
      f('category', 'string', '品类', '商品所属品类'),
      f('brand', 'string', '品牌', '商品品牌'),
      f('price', 'decimal', '标价', '商品标价（元）'),
    ],
  },
  {
    name: 'event',
    label: '行为事件',
    description: '消费者在网站、App、小程序上的一次行为（浏览、加购、登录等）。',
    key: ['event_id'],
    fields: [
      f('event_id', 'string', '事件 ID', '事件的唯一标识；源端没有时可用字段拼出'),
      f('customer_id', 'string', '消费者 ID', '已登录时的消费者，匿名时为空', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('device_id', 'string', '设备 ID', '匿名访问时的设备标识'),
      f('event_type', 'string', '事件类型', '如 view、add_to_cart、login'),
      f('occurred_at', 'timestamp', '发生时间', '事件发生的时间'),
      f('page', 'string', '页面', '事件发生的页面或屏幕'),
    ],
  },
  {
    name: 'touch',
    label: '营销触达',
    description: '一次对消费者的营销触达（短信、邮件、推送等）。',
    key: ['touch_id'],
    fields: [
      f('touch_id', 'string', '触达 ID', '源端的触达记录标识'),
      f('customer_id', 'string', '消费者 ID', '被触达的消费者', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('campaign_id', 'string', '活动 ID', '所属营销活动'),
      f('channel', 'string', '触达渠道', '触达使用的渠道', { enum: CHANNELS }),
      f('status', 'string', '触达结果', '触达的最终结果', { enum: ['sent', 'delivered', 'opened', 'clicked', 'failed'] }),
      f('sent_at', 'timestamp', '发送时间', '触达发出的时间'),
    ],
  },
  {
    name: 'membership',
    label: '会员',
    description: '消费者在会员体系中的身份（会员是消费者的一个属性，不是另一种人）。',
    key: ['membership_id'],
    fields: [
      f('membership_id', 'string', '会员号', '源端的会员卡号或会员标识'),
      f('customer_id', 'string', '消费者 ID', '持有会员身份的消费者', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('level', 'string', '会员等级', '会员等级名称（如 gold、silver）'),
      f('points', 'integer', '积分', '当前积分余额'),
      f('status', 'string', '会员状态', '会员身份的当前状态', { enum: ['active', 'frozen', 'expired', 'cancelled'] }),
      f('joined_at', 'timestamp', '入会时间', '成为会员的时间'),
      f('expires_at', 'timestamp', '到期时间', '会员身份到期的时间，长期有效为空'),
    ],
  },
  {
    name: 'points_transaction',
    label: '积分流水',
    description: '一笔积分变动（获得、消费抵扣、兑换、过期、调整）。当前余额看会员的积分，获取与消耗看积分流水。',
    key: ['points_transaction_id'],
    fields: [
      f('points_transaction_id', 'string', '流水 ID', '源端的积分流水标识；源端没有时可用字段拼出'),
      f('customer_id', 'string', '消费者 ID', '积分所属的消费者，对应消费者的 customer_id', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('membership_id', 'string', '会员号', '积分所属的会员，对应会员的 membership_id', { ref: { entity: 'membership', field: 'membership_id' } }),
      f('change_type', 'string', '变动类型', '获得、消费抵扣、兑换礼品或权益、过期、人工调整（含退款冲回）', { enum: ['earn', 'spend', 'redeem', 'expire', 'adjust'] }),
      f('points_change', 'integer', '变动积分', '带正负：增加为正，减少为负'),
      f('balance_after', 'integer', '变动后余额', '这笔变动之后的积分余额，源端没有为空'),
      f('order_id', 'string', '关联订单', '产生或使用这笔积分的订单，对应订单的 order_id', { ref: { entity: 'order', field: 'order_id' } }),
      f('occurred_at', 'timestamp', '发生时间', '积分变动的时间'),
      f('expires_at', 'timestamp', '到期时间', '这笔获得的积分的到期时间，不过期或不是获得为空'),
    ],
  },
  {
    name: 'consent',
    label: '营销同意',
    description: '消费者在某个渠道上是否同意接收营销信息的当前状态（隐私协议、用户协议的签署不在这里）。源端是变更日志时按更新时间取最新。',
    key: ['customer_id', 'channel'],
    fields: [
      f('customer_id', 'string', '消费者 ID', '对应消费者的 customer_id', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('channel', 'string', '渠道', '同意接收营销信息的渠道，与营销触达的渠道是同一套', { enum: CHANNELS }),
      f('status', 'string', '同意状态', '同意，或撤回、拒绝', { enum: ['granted', 'revoked'] }),
      f('granted_at', 'timestamp', '同意时间', '最近一次同意的时间'),
      f('revoked_at', 'timestamp', '撤回时间', '最近一次撤回的时间，没撤回过为空'),
      f('updated_at', 'timestamp', '更新时间', '源端最后一次修改这条记录的时间'),
    ],
  },
  {
    name: 'preference',
    label: '兴趣偏好',
    description: '消费者的一条偏好（键值），同一类型下可以有多个值。只放源端记录的偏好，平台按行为推断的偏好是标签。',
    key: ['customer_id', 'preference_type', 'preference_value'],
    fields: [
      f('customer_id', 'string', '消费者 ID', '对应消费者的 customer_id', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('preference_type', 'string', '偏好类型', '如 category（品类）、brand（品牌）、flavor（口味）、size（尺码）'),
      f('preference_value', 'string', '偏好值', '偏好的取值（如某个品类名、品牌名）'),
      f('updated_at', 'timestamp', '更新时间', '源端最后一次修改这条记录的时间'),
    ],
  },
  {
    name: 'coupon',
    label: '优惠券',
    description: '发给消费者的一张券（发放、核销、过期、作废）。面额、类型等券的定义在券模板里，券上只留这张券自己的事实。金额以元计。',
    key: ['coupon_id'],
    fields: [
      f('coupon_id', 'string', '券 ID', '源端的券实例标识或券码'),
      f('coupon_template_id', 'string', '券模板 ID', '这张券的模板，对应券模板的 coupon_template_id', { ref: { entity: 'coupon_template', field: 'coupon_template_id' } }),
      f('campaign_id', 'string', '活动 ID', '发券的营销活动，与营销触达的 campaign_id 同义'),
      f('customer_id', 'string', '消费者 ID', '领到这张券的消费者', { ref: { entity: 'customer', field: 'customer_id' } }),
      f('status', 'string', '券状态', '已发放（未使用）、已核销、已过期、已作废', { enum: ['issued', 'redeemed', 'expired', 'voided'] }),
      f('issued_at', 'timestamp', '发放时间', '券发到消费者手里的时间'),
      f('redeemed_at', 'timestamp', '核销时间', '券被使用的时间，未核销为空'),
      f('order_id', 'string', '核销订单', '使用这张券的订单，对应订单的 order_id', { ref: { entity: 'order', field: 'order_id' } }),
      f('discount_amount', 'decimal', '抵扣金额', '核销时实际抵扣的金额（元），未核销为空'),
      f('expires_at', 'timestamp', '到期时间', '这张券的到期时间'),
      f('updated_at', 'timestamp', '更新时间', '源端最后一次修改这条记录的时间'),
    ],
  },
  {
    name: 'coupon_template',
    label: '券模板',
    description: '券的定义（券批次）：类型、面额或折扣、使用门槛。金额以元计。',
    key: ['coupon_template_id'],
    fields: [
      f('coupon_template_id', 'string', '券模板 ID', '源端的券模板或券批次标识'),
      f('name', 'string', '券名称', '券的名称'),
      f('coupon_type', 'string', '券类型', '代金（含满减）、折扣、赠品（含兑换）、免运费、其他', { enum: ['cash', 'discount', 'gift', 'shipping', 'other'] }),
      f('face_value', 'decimal', '面额', '代金券、满减券的面额（元），其他类型为空'),
      f('pay_percent', 'decimal', '应付比例', '折扣券打折后应付的百分比（85 折写 85、87.5 折写 87.5），其他类型为空'),
      f('min_spend', 'decimal', '使用门槛', '满多少元可用（元），无门槛为空'),
    ],
  },
];

export type CanonicalEntityName = string;

export const entityOf = (name: string) => CANONICAL_ENTITIES.find(e => e.name === name);

/** 自定义实体的名称：custom_ 开头，小写字母、数字与下划线 */
export const CUSTOM_ENTITY_PATTERN = '^custom_[a-z][a-z0-9_]*$';
/** 标准实体上的扩展字段：x_ 开头，避免与标准模型以后新增的字段重名 */
export const EXTENSION_PATTERN = '^x_[a-z][a-z0-9_]*$';
/** 自定义实体的字段名 */
export const CUSTOM_FIELD_PATTERN = '^[a-z][a-z0-9_]*$';

/** 自定义实体的类型：维度或事实，只用于引导 */
export const CUSTOM_ENTITY_KINDS = { dimension: '维度', fact: '事实' } as const;
export type CustomEntityKind = keyof typeof CUSTOM_ENTITY_KINDS;
/** 自定义实体登记的一个字段；敏感字段在标准层只存哈希，类型只能是 string */
export interface CustomEntityField { name: string; type: FieldType; description: string; sensitive: boolean }

export const isCustomEntity = (name: string) => new RegExp(CUSTOM_ENTITY_PATTERN).test(name);

/** 实体的展示名称：标准实体用中文名，自定义实体用名称本身 */
export const entityLabel = (name: string) => entityOf(name)?.label ?? name;
