import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * 打开 Chrome DevTools 时浏览器会自动请求这个路径（Automatic Workspace Folders）；
 * 开发时直接回 404，免得每次都进 React Router 打出一段 "No route matches URL" 的堆栈
 */
function ignoreChromeDevtoolsProbe(): Plugin {
  return {
    name: "ignore-chrome-devtools-probe",
    configureServer(server) {
      server.middlewares.use("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [ignoreChromeDevtoolsProbe(), tailwindcss(), reactRouter()],
  // 浏览器端一旦请求到 app/.server/pipeline/lake-engine.ts（React Router 只拦截 import，不拦直接请求），
  // Vite 会把 DuckDB 登记为浏览器端依赖去预构建，原生模块 duckdb.node 打包失败（UNLOADABLE_DEPENDENCY）
  optimizeDeps: { exclude: ["@duckdb/node-api"] },
  resolve: {
    tsconfigPaths: true,
  },
});
