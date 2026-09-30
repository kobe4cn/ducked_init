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
  resolve: {
    tsconfigPaths: true,
  },
});
