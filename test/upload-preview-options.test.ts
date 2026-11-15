// 上传前预览的读取选项（纯函数，#727，ADR-0037）：hidden options 与「重新预览」提交的 JSON。
// 只改了列类型时带 columns；改了编码 / 分隔符 / 表头 / 跳过行数（结构性选项）后不带 columns，交给服务端照新选项自动识别——
// 否则旧列名与旧类型会套到新读法上（列数对不上 400，或表头行当数据读、登记成功首次同步才失败）
import { describe, expect, it } from 'vitest';
import { uploadOptionsJson, type PreviewChoices } from '../app/lib/upload-preview-options';

const RESULT = {
  encoding: 'gbk' as const, delim: ',', header: true, skip: 0,
  columns: [{ name: '报名编号', type: 'BIGINT' }, { name: '姓名', type: 'VARCHAR' }],
};
const SAME: PreviewChoices = { encoding: 'gbk', delim: ',', header: true, skip: '0', types: { 报名编号: 'BIGINT', 姓名: 'VARCHAR' } };

describe('uploadOptionsJson', () => {
  it('没有预览结果时为空串，登记照自动识别', () => {
    expect(uploadOptionsJson('signups', null, SAME)).toBe('');
  });

  it('选项没改时带识别出的列与类型；改了列类型带改后的类型', () => {
    expect(JSON.parse(uploadOptionsJson('signups', RESULT, SAME))).toEqual({
      signups: { encoding: 'gbk', delim: ',', header: true, skip: 0, columns: { 报名编号: 'BIGINT', 姓名: 'VARCHAR' } },
    });
    const typed = JSON.parse(uploadOptionsJson('signups', RESULT, { ...SAME, types: { ...SAME.types, 报名编号: 'VARCHAR' } }));
    expect(typed.signups.columns).toEqual({ 报名编号: 'VARCHAR', 姓名: 'VARCHAR' });
  });

  it.each<[string, Partial<typeof SAME>]>([
    ['取消「第一行是表头」', { header: false }],
    ['改分隔符', { delim: ';' }],
    ['改编码', { encoding: 'utf-8' }],
    ['改跳过行数', { skip: '1' }],
  ])('%s后没重新预览：不带 columns，只带结构性选项', (_, patch) => {
    const opts = JSON.parse(uploadOptionsJson('signups', RESULT, { ...SAME, ...patch })).signups;
    expect(opts).not.toHaveProperty('columns');
    expect(opts).toEqual({
      encoding: patch.encoding ?? 'gbk', delim: patch.delim ?? ',', header: patch.header ?? true, skip: Number(patch.skip ?? 0),
    });
  });

  it('跳过行数不合法时退回识别出的值', () => {
    expect(JSON.parse(uploadOptionsJson('signups', RESULT, { ...SAME, skip: 'abc' })).signups.skip).toBe(0);
  });
});
