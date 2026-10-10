import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("JEV_ON_NONE default", () => {
  it("lets Codex decide when Jev says no tool is needed unless explicitly configured otherwise", () => {
    expect(loadConfig({ JEV_CLIENT: "codex" }).onNone).toBe("passthrough");
    expect(loadConfig({ JEV_CLIENT: "codex", JEV_ON_NONE: "force_none" }).onNone).toBe("force_none");
  });

  it("keeps force_none for every other client", () => {
    expect(loadConfig({}).onNone).toBe("force_none");
    expect(loadConfig({ JEV_CLIENT: "claude" }).onNone).toBe("force_none");
    expect(loadConfig({ JEV_ON_NONE: "passthrough" }).onNone).toBe("passthrough");
  });

  it("reads a blank JEV_ON_NONE as unset, which is how .env.example ships it", () => {
    expect(loadConfig({ JEV_CLIENT: "codex", JEV_ON_NONE: "" }).onNone).toBe("passthrough");
    expect(loadConfig({ JEV_ON_NONE: "  " }).onNone).toBe("force_none");
  });
});

describe("boolean settings", () => {
  it.each(["1", "true", "TRUE", "yes", "On", " on "])("reads %j as true", (value) => {
    expect(loadConfig({ JEV_SHADOW: value }).shadow).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "Off", " off "])("reads %j as false", (value) => {
    expect(loadConfig({ JEV_ROUTING: value }).routing).toBe(false);
  });

  it("uses the default when the setting is missing or blank", () => {
    expect(loadConfig({}).shadow).toBe(false);
    expect(loadConfig({ JEV_SHADOW: "" }).shadow).toBe(false);
    expect(loadConfig({ JEV_ROUTING: "  " }).routing).toBe(true);
    expect(loadConfig({}).directCalls).toBe(true);
  });

  it("refuses a value that is not a boolean instead of reading it as false", () => {
    expect(() => loadConfig({ JEV_SHADOW: "ture" })).toThrow(
      'JEV_SHADOW must be true or false (also 1/0, yes/no, on/off), got "ture"',
    );
  });

  it("names the setting for every boolean setting", () => {
    expect(() => loadConfig({ JEV_ROUTING: "of" })).toThrow('JEV_ROUTING must be true or false (also 1/0, yes/no, on/off), got "of"');
    expect(() => loadConfig({ JEV_DIRECT_CALLS: "flase" })).toThrow(
      'JEV_DIRECT_CALLS must be true or false (also 1/0, yes/no, on/off), got "flase"',
    );
  });
});
