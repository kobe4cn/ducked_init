import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // 测试用临时目录构建，不覆盖 build/（见 test/client-build.test.ts）
  buildDirectory: process.env.REACT_ROUTER_BUILD_DIR ?? 'build',
} satisfies Config;
