import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};
const webPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};

describe("root dev:web script", () => {
  it("forwards an explicit Vite port after the npm separator and keeps it strict", () => {
    expect(rootPackage.scripts?.["dev:web"]).toBe(
      "npm run dev --workspace @papercusp/sidestage-web -- --strictPort",
    );
  });
});

describe("web package test scripts", () => {
  it("pins package tests to the web project and keeps focused runs available", () => {
    expect(webPackage.scripts?.test).toBe(
      "vitest run --config ../../vitest.config.mts --project sidestage-web",
    );
    expect(webPackage.scripts?.["test:file"]).toBe("vitest run");
  });
});
