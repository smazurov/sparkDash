import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("power-meter routes sit behind auth; start follows listen and stop is in shutdown", () => {
  const server = read("server/index.js");
  const authAt = server.indexOf("app.use(createAuthMiddleware());");
  const registerAt = server.indexOf("powerMeters.register(app);");
  assert.ok(authAt > 0 && registerAt > authAt);
  assert.ok(server.indexOf("powerMeters.start();") > server.indexOf("server.listen(PORT, BIND_HOST"));
  assert.ok(server.indexOf("powerMeters.stop();") > server.indexOf("async function shutdown"));
  assert.match(server, /renderPrometheusMetrics\(entries\) \+ powerMeters\.renderPrometheus\(\)/);
});

test("the power-meter tests run with the server suite", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["test:server"], /server\/powermeter\/__tests__\/\*\.test\.js/);
});

test("providers stay behind one registry, and the module imports nothing feature-specific", () => {
  const dir = path.join(root, "server/powermeter");
  const files = fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".js") && !f.includes("__tests__"))
    .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
  for (const [file, text] of files) {
    for (const [, spec] of text.matchAll(/from "(\.\.\/[^"]+)"/g)) {
      const resolved = path.normalize(path.join(path.dirname(file), spec));
      // Only the shared config root and the atomic writer are borrowed from the rest of the server.
      assert.ok(["../config.js", "../energy/atomicWrite.js"].includes(resolved), `${file} imports ${spec}`);
    }
  }
});
