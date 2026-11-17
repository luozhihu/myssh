import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configExampleJSON,
  configJSONSkeleton,
  defaultHome,
  scaffoldHome,
} from "../../src/cli/files.js";
import { tempDir } from "../helpers/config.js";

async function mode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

describe("scaffoldHome", () => {
  it("creates dir 0700, config 0600, and example 0600", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const home = path.join(dir, "sshmng-home");
      await scaffoldHome(home, {});
      expect(await mode(home)).toBe(0o700);
      const config = path.join(home, "config.json");
      expect(await mode(config)).toBe(0o600);
      expect(await mode(path.join(home, "config.example.json"))).toBe(0o600);
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual(JSON.parse(configJSONSkeleton));
      expect(() => JSON.parse(configExampleJSON)).not.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("preserves an existing config unless overwrite is requested", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const home = path.join(dir, "h");
      await mkdir(home);
      const config = path.join(home, "config.json");
      await writeFile(config, '{"version":"1","custom":true}');
      await scaffoldHome(home, {});
      expect(await readFile(config, "utf8")).toBe('{"version":"1","custom":true}');
      await scaffoldHome(home, { overwriteConfig: true });
      expect(await readFile(config, "utf8")).toBe(configJSONSkeleton);
    } finally {
      await cleanup();
    }
  });

  it("always rewrites the example file", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const home = path.join(dir, "h");
      await mkdir(home);
      const example = path.join(home, "config.example.json");
      await writeFile(example, "old");
      await scaffoldHome(home, {});
      expect(await readFile(example, "utf8")).toBe(configExampleJSON);
    } finally {
      await cleanup();
    }
  });
});

describe("defaultHome", () => {
  it("prefers SSHMNG_HOME then ~/.sshmng", () => {
    expect(defaultHome({ SSHMNG_HOME: "/custom" }, "/home/u")).toBe("/custom");
    expect(defaultHome({}, "/home/u")).toBe(path.join("/home/u", ".sshmng"));
  });
});
