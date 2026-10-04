// 顶栏导航的高亮（纯函数）：当前路径归到最具体的导航项下，子页面高亮所属的导航项，上级导航项不跟着高亮
import { describe, expect, it } from 'vitest';
import { activeNavTo } from '../app/lib/nav';

const MEMBER_NAV = [{ to: '/' }, { to: '/sources' }, { to: '/mappings' }, { to: '/model' }, { to: '/analytics' }];
const OPS_NAV = [{ to: '/ops' }, { to: '/ops/audit' }];

describe('导航高亮', () => {
  it('页面本身与它的子页面都高亮所属的导航项', () => {
    expect(activeNavTo(MEMBER_NAV, '/sources')).toBe('/sources');
    expect(activeNavTo(MEMBER_NAV, '/sources/123')).toBe('/sources');
    expect(activeNavTo(MEMBER_NAV, '/')).toBe('/');
    expect(activeNavTo(MEMBER_NAV, '/analytics/snapshots/abc')).toBe('/analytics');
  });

  it('只按完整的路径段匹配，前缀相同的其他页面不算', () => {
    expect(activeNavTo([{ to: '/model' }, { to: '/' }], '/models')).toBe('/');
    expect(activeNavTo([{ to: '/model' }], '/models')).toBeUndefined();
  });

  it('运营后台：审计日志只高亮自己，租户详情高亮「租户」', () => {
    expect(activeNavTo(OPS_NAV, '/ops/audit')).toBe('/ops/audit');
    expect(activeNavTo(OPS_NAV, '/ops/tenants/abc')).toBe('/ops');
    expect(activeNavTo(OPS_NAV, '/ops')).toBe('/ops');
  });
});
