import { configDefaults, defineConfig } from "vitest/config";

// `tests/slow` holds what needs real wall-clock time (the native scheduler's
// minute-grained ticker). Left out of the default run, and run on its own,
// never skipped, when REAM_RUN_SLOW_TESTS=1 — CI has a step for it.
const slow = process.env.REAM_RUN_SLOW_TESTS === "1";

export default defineConfig({
	// The tests use parameter decorators (`constructor(@Inject(...) x)`), which
	// only TypeScript's legacy decorators allow. `tsconfig.json` turns them on but
	// includes `src` alone, and vite 8's oxc transform honours that `include`, so
	// it read `tests/` with standard decorators and refused them. Asked here, for
	// every file the suite loads. (vite 7's esbuild ignores the key.)
	oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
	test: {
		exclude: slow
			? configDefaults.exclude
			: [...configDefaults.exclude, "tests/slow/**"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: [
				"src/**/*.d.ts",
				// The debug toolbar's browser code: Node never loads it, so v8 sees
				// a thousand uncovered lines. It is checked as the embedded string
				// it ships as, and in a real browser.
				"src/profiler/client/**",
			],
			reporter: ["text-summary", "json-summary"],
			// Just under what the suite reaches, and now actually run. They read
			// 55/53/45/53 — some thirty points below reality — while nothing
			// ever checked them, so the gate would have let most of the suite
			// disappear without a word.
			thresholds: {
				lines: 86,
				statements: 85,
				branches: 76,
				functions: 84,
			},
		},
	},
});
