// app/.server/i18n.ts —— 服务端词典：msg() 的描述对象按界面语言出字符串（英文查 en.server.json，ADR-0060）
import enServer from '../i18n/en.server.json';
import { translate, type Locale, type Msg } from '~/lib/i18n';

export function formatServer(locale: Locale, m: Msg): string {
  return translate(locale, enServer, m.key, m.params);
}
