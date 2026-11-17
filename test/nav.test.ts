// 顶栏导航的高亮与分组（纯函数）：当前路径归到最具体的导航项下，子页面高亮所属的导航项，上级导航项不跟着高亮；
// 分组导航按角色过滤子项，一个分组里子项全都看不到时整个分组不显示
import { describe, expect, it } from 'vitest';
import { activeGroupLabel, activeNavTo, flattenNav, type NavEntry } from '../app/lib/nav';
import { navFor } from '../app/.server/nav';
import type { CurrentMember } from '../app/.server/auth';

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

const member = (role: CurrentMember['role']) => ({ role }) as CurrentMember;

/** 把分组结构压成「概览 / 数据接入(数据源、映射、…)」的轮廓，整体断言分组与子项 */
const outline = (nav: NavEntry[]) => nav.map(entry => ('items' in entry ? `${entry.label}(${entry.items.map(item => item.label).join('、')})` : entry.label));

describe('导航分组', () => {
  it('查看者：概览、数据模型、分析（仅指标与标签）与任务，没有数据接入与管理', () => {
    expect(outline(navFor(member('viewer')))).toEqual([
      '概览',
      '数据模型(标准模型、数据地图、业务知识)',
      '分析(指标与标签)',
      '任务',
    ]);
  });

  it('分析师：多了数据接入（4 项）与查询，仍没有管理', () => {
    expect(outline(navFor(member('analyst')))).toEqual([
      '概览',
      '数据接入(数据源、映射、自定义实体、数据质量)',
      '数据模型(标准模型、数据地图、业务知识)',
      '分析(指标与标签、查询)',
      '任务',
    ]);
  });

  it('管理员：6 个分组，管理下 6 项', () => {
    expect(outline(navFor(member('admin')))).toEqual([
      '概览',
      '数据接入(数据源、映射、自定义实体、数据质量)',
      '数据模型(标准模型、数据地图、业务知识)',
      '分析(指标与标签、查询)',
      '任务',
      '管理(成员、API Key、模型服务、模型调用、审计日志、解密)',
    ]);
  });

  it('当前页所在分组：先按最具体路径找到导航项，再返回包含它的分组；单链接（概览、任务）不算分组', () => {
    const nav = navFor(member('admin'));
    expect(activeNavTo(flattenNav(nav), '/sources/123')).toBe('/sources');
    expect(activeGroupLabel(nav, '/sources/123')).toBe('数据接入');
    expect(activeGroupLabel(nav, '/analytics/snapshots/abc')).toBe('分析');
    expect(activeGroupLabel(nav, '/')).toBeUndefined();
    expect(activeGroupLabel(nav, '/tasks')).toBeUndefined();
  });
});
