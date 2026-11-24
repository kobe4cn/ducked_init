// test/sensitive.test.ts —— 列名像敏感信息的判断（app/lib/sensitive.ts，纯函数，不连库）：
// openid / unionid / 企微 external_userid / 天猫 ouid 等第三方用户 ID 也算敏感列（#1212），
// 内部主键 id / customer_id / user_id 等不算
import { describe, expect, it } from 'vitest';
import { SENSITIVE_NAME, looksSensitive } from '../app/lib/sensitive';

describe('第三方用户 ID 列名', () => {
  it('openid、unionid、external_userid、ouid 等中英文写法都算敏感', () => {
    for (const name of ['openid', '买家openid', 'buyer_openid', 'unionid', 'unionid_raw', 'wx_union_id', 'external_userid',
      'third_party_user_id', 'ouid', '外部用户ID', '第三方编号']) {
      expect(SENSITIVE_NAME.test(name), name).toBe(true);
      expect(looksSensitive({ name }), name).toBe(true);
    }
  });

  it('内部主键与普通 ID 列不算', () => {
    for (const name of ['id', 'customer_id', 'user_id', 'member_id', 'order_id', 'buyer_id', 'guide_id', 'scan_id', 'status']) {
      expect(looksSensitive({ name }), name).toBe(false);
    }
  });
});
