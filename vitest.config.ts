import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
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
