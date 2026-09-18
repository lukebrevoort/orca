import { build } from "vite";
import { gzipSync } from "node:zlib";
import { relative, resolve } from "node:path";

// Run from any directory: bun apps/web/scripts/check-bundle.ts
// This uses the production config and leaves dist ready for a preview smoke test.
const root = resolve(import.meta.dirname, "..");
const limit = 500_000; // Vite's default warning threshold, in uncompressed bytes.
await build({
  configFile: resolve(root, "vite.config.ts"),
  plugins: [{
    name: "check-production-bundle",
    enforce: "post",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const errors: string[] = [];
      const visited = new Set<string>();
      const active = new Set<string>();
      const visit = (name: string) => {
        if (active.has(name)) {
          errors.push(`Circular static chunk import: ${[...active, name].join(" -> ")}`);
          return;
        }
        if (visited.has(name)) return;
        visited.add(name);
        active.add(name);
        for (const dependency of byName.get(name)?.imports ?? []) visit(dependency);
        active.delete(name);
      };
      for (const chunk of chunks) {
        visit(chunk.fileName);
        const bytes = Buffer.byteLength(chunk.code);
        console.log(`${chunk.fileName}: ${(bytes / 1000).toFixed(2)} kB, gzip ${(gzipSync(chunk.code).byteLength / 1000).toFixed(2)} kB`);
        if (bytes > limit) errors.push(`${chunk.fileName} exceeds ${limit} bytes (${bytes})`);
        const modules = Object.entries(chunk.modules);
        for (const [id] of modules) {
          if (id.includes("feedback-kit") || id.endsWith("/development-feedback.tsx")) {
            errors.push(`Development feedback included in production: ${id}`);
          }
        }
        // Rollup renderedLength is before final chunk minification; use it to
        // compare contributors, not as a claim about transferred module bytes.
        for (const [id, info] of modules.sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 5)) {
          console.log(`  ${(info.renderedLength / 1000).toFixed(2)} kB rendered: ${relative(root, id)}`);
        }
      }
      if (errors.length) this.error(errors.join("\n"));
      console.log("Bundle checks passed: every JS chunk below 500 kB, no static chunk cycles, no development feedback.");
    },
  }],
});
