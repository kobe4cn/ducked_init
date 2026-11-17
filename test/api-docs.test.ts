// test/api-docs.test.ts —— 外部接口登记表的守卫（不起应用）：app/routes/api.v1.*.tsx 的每个外部接口路由文件、
// app/routes.ts 里注册的每个 api/v1 路由都必须在登记表里，登记表里也不能有已经不存在的；以后加接口漏登记、删接口忘删条目，这里都会失败。
// curl 示例一律用占位符 <你的 API Key> 与 <平台地址>，页面上不会出现真实 Key；下载接口只认链接令牌、不带 Bearer
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_ENDPOINTS } from '../app/lib/api-docs';

const root = join(import.meta.dirname, '..');

describe('外部接口登记表', () => {
  it('app/routes 里每个 api.v1.*.tsx 都在登记表里，登记表没有多余或重复的文件', () => {
    const files = readdirSync(join(root, 'app', 'routes'))
      .filter(name => /^api\.v1\..*\.tsx$/.test(name))
      .map(name => `routes/${name}`)
      .sort();
    expect(files).not.toHaveLength(0);
    const registered = API_ENDPOINTS.map(e => e.file).sort();
    expect([...new Set(registered)], '登记表里有重复的文件').toHaveLength(registered.length);
    expect(registered).toEqual(files);
  });

  it('app/routes.ts 里注册的每个 api/v1 路由都和登记表的 {route, file} 一一对应，两边都没有多余项', () => {
    const routes = [...readFileSync(join(root, 'app', 'routes.ts'), 'utf8')
      .matchAll(/route\('(api\/v1\/[^']+)', '([^']+)'\)/g)]
      .map(([, route, file]) => `${file} ${route}`)
      .sort();
    expect(routes).not.toHaveLength(0);
    const registered = API_ENDPOINTS.map(e => `${e.file} ${e.route}`).sort();
    expect(routes, 'routes.ts 里有登记表没有的路由').toEqual(registered);
  });

  it('curl 示例一律写 <你的 API Key> 与 <平台地址> 占位符；下载接口不带 Bearer', () => {
    for (const e of API_ENDPOINTS) {
      if (e.route.endsWith('/download')) {
        expect(e.curl, e.route).not.toContain('Bearer');
        expect(e.curl, e.route).toContain('token=');
      } else {
        expect(e.curl, e.route).toContain('<你的 API Key>');
      }
      expect(e.curl, e.route).toContain('<平台地址>');
    }
  });
});
