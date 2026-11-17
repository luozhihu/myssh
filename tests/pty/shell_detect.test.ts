import { describe, expect, it } from "vitest";
import { buildRC, parseShellDetect } from "../../src/pty/shell_detect.js";

describe("parseShellDetect", () => {
  it("requires the end marker and takes the last detection line", () => {
    const stream = [
      "__sshmng_dr=ab12; echo __SHELL_DETECT__:$0:${BASH_VERSION:-}:${ZSH_VERSION:-}; echo __DETECT_END_${__sshmng_dr}__",
      "__SHELL_DETECT__:/bin/bash:5.2.15(1)-release:",
      "__DETECT_END_ab12__",
      "",
    ].join("\r\n");
    expect(parseShellDetect(stream, "ab12")).toEqual({ shell: "bash", ok: true });
  });

  it("returns ok=false without the end marker", () => {
    expect(parseShellDetect("__SHELL_DETECT__:/bin/bash:5.2:", "ab12")).toEqual({
      shell: "",
      ok: false,
    });
  });

  it("classifies zsh, ash, dash/sh and unknown shells", () => {
    const line = (value: string) => `__SHELL_DETECT__:${value}\r\n__DETECT_END_x__\r\n`;
    expect(parseShellDetect(line("/usr/bin/zsh::5.9"), "x").shell).toBe("zsh");
    expect(parseShellDetect(line("/bin/busybox::"), "x").shell).toBe("ash");
    expect(parseShellDetect(line("/bin/sh::"), "x").shell).toBe("dash");
    expect(parseShellDetect(line("/usr/bin/fish::"), "x").shell).toBe("fish");
  });
});

describe("buildRC", () => {
  it("sets PS1 last and never contains a Tab", () => {
    for (const shell of ["bash", "zsh", "dash", "unknown"]) {
      const rc = buildRC(shell, "sid123");
      expect(rc).not.toContain("\t");
      expect(rc.lastIndexOf("export PS1=")).toBeGreaterThan(rc.lastIndexOf("stty -echo"));
      expect(rc).toContain("export TERM=dumb");
      expect(rc).toContain("stty cols 120 rows 100");
    }
  });

  it("uses $(echo _$?) for bash/zsh and __P_ for the rest", () => {
    expect(buildRC("bash", "sid123")).toContain("export PS1='$(echo _$?)__sid123___]# '");
    expect(buildRC("bash", "sid123")).toContain("set +o history");
    expect(buildRC("zsh", "sid123")).toContain("setopt PROMPT_SUBST");
    expect(buildRC("dash", "sid123")).toContain("export PS1='__P_sid123__> '");
    expect(buildRC("dash", "sid123")).not.toContain("$(echo _$?)");
  });
});
