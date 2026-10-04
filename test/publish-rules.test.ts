// 双人发布规则（ADR-0015）：当前成员发布不了某一版的原因——不是草稿、没有发布权限、最后保存的是自己、租户里只有自己能发布（纯函数）
import { describe, expect, it } from 'vitest';
import type { CurrentMember } from '../app/.server/auth';
import type { Role } from '../app/.server/db/schema';
import { publishBlocker, publishReason } from '../app/.server/publish-rules';

const member = (email: string, role: Role): CurrentMember => ({
  memberId: email,
  email,
  role,
  tenant: { id: 't', slug: 'acme', name: 'Acme' },
  space: { id: 's', name: '默认空间' },
});

const de = member('de@acme.com', 'data_engineer');
const reason = (actor: CurrentMember, v: { status: string; lastEditor: string }, publishers = 2) =>
  publishReason(actor, { ...v, publishBlocker: publishBlocker(actor, v) }, publishers);

describe('publishReason', () => {
  it('不是草稿时为 null', () => {
    expect(reason(de, { status: 'published', lastEditor: 'de@acme.com' })).toBeNull();
  });

  it('没有发布权限时说明谁能发布', () => {
    expect(reason(member('an@acme.com', 'analyst'), { status: 'draft', lastEditor: 'de@acme.com' })).toMatch(/^仅.*可以发布映射与定义$/);
  });

  it('最后保存的是自己时不能发布；租户里只有自己能发布时提示先邀请成员', () => {
    const own = { status: 'draft', lastEditor: 'de@acme.com' };
    expect(reason(de, own)).toBe('你最后改了这一版草稿，需由另一位数据工程师或管理员发布');
    expect(reason(de, own, 1)).toBe('本租户只有你有发布权限，请先邀请一位数据工程师或管理员');
  });

  it('别人最后保存的草稿可以发布', () => {
    expect(reason(de, { status: 'draft', lastEditor: 'de2@acme.com' }, 1)).toBeNull();
  });
});
