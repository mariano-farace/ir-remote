import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcAlias = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": srcAlias,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          // Only test files, never the `support/` helpers beside them. The
          // helpers are matched by the same `**` otherwise, which both runs
          // them as if they were tests and gives every test file its own
          // `globalSetup` — one container per file, all sharing a database name.
          include: [
            "tests/integration/**/*.test.ts",
            "tests/contract/**/*.test.ts",
            "!tests/integration/support/**",
          ],
          // One PostgreSQL container per run, migrated and seeded once; each
          // test truncates the script-owned tables (tests/integration/support).
          globalSetup: ["tests/integration/support/global-setup.ts"],
          // One container is shared by every test file, so a file must not seed
          // implicit cross-file state. Each test resets the database itself.
          fileParallelism: false,
          // Container startup plus a real database is slower than a unit run.
          hookTimeout: 180_000,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // `include` is what makes the per-module floor non-vacuous: every
      // application source file is instrumented, not only the ones a test
      // happens to import. Without it an untouched module is simply absent
      // from the report and passes at 100%.
      include: ["src/**/*.{ts,tsx}"],
      // Every exclusion is declared here rather than left implicit (Principle II).
      //   *.d.ts             type-only, no runtime code to cover
      //   src/lib/domain/types.ts
      //                      type aliases, interfaces, and doc comments only:
      //                      the module emits no runtime code (its invariants
      //                      are asserted through the modules that use it).
      //                      The domain floor itself still applies per file.
      //   src/lib/repositories/types.ts
      //                      interfaces plus a bare Error subclass; the only
      //                      executable line is an error-code mapping, and the
      //                      behaviour behind it is covered through the
      //                      repositories. No decision logic lives here.
      //   src/app/**         Next.js App Router entry points (pages, layouts,
      //                      route handlers) and the React panels they render.
      //                      Vitest cannot render async Server Components, and
      //                      the panels' behaviour is covered end to end by
      //                      Playwright, which plan.md names as the E2E and
      //                      async-component runner.
      exclude: [
        "src/**/*.d.ts",
        "src/lib/domain/types.ts",
        "src/lib/repositories/types.ts",
        "src/app/**",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        // Decision-logic modules carry a higher floor (constitution Principle II).
        // Glob thresholds do not inherit the top-level `perFile`, so each glob
        // sets it explicitly.
        "src/lib/domain/**": {
          lines: 95,
          branches: 90,
          functions: 90,
          statements: 95,
          perFile: true,
        },
        "src/stores/**": {
          lines: 95,
          branches: 90,
          functions: 90,
          statements: 95,
          perFile: true,
        },
      },
    },
  },
});
