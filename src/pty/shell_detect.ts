function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ShellDetectResult {
  shell: string;
  ok: boolean;
}

/** 解析 detect 输出；必须出现展开后的 end marker，取最后一条结果行。 */
export function parseShellDetect(stream: string, rand: string): ShellDetectResult {
  if (!new RegExp(`__DETECT_END_${escapeRegex(rand)}__`).test(stream)) {
    return { shell: "", ok: false };
  }
  const detectRe = /__SHELL_DETECT__:([^:\r\n]*):([^:\r\n]*):([^:\r\n]*)\r?$/gm;
  let last: RegExpExecArray | null = null;
  for (let match = detectRe.exec(stream); match; match = detectRe.exec(stream)) {
    last = match;
  }
  if (!last) return { shell: "", ok: false };
  return {
    shell: classifyShell(last[1] ?? "", last[2] ?? "", last[3] ?? ""),
    ok: true,
  };
}

export function classifyShell(shellPath: string, bashVersion: string, zshVersion: string): string {
  const base = shellPath.slice(shellPath.lastIndexOf("/") + 1);
  if (bashVersion !== "") return "bash";
  if (zshVersion !== "") return "zsh";
  switch (base) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "ash":
    case "busybox":
      return "ash";
    case "dash":
    case "sh":
      return "dash";
    default:
      return base;
  }
}

/**
 * 生成 RC 注入脚本（PS1-only 设计）。locale 探测块必须用空格缩进，
 * 绝不能用 Tab：交互式 bash 的 readline 会把 Tab 当补全键并阻塞。
 */
export function buildRC(shell: string, sid: string): string {
  const common = `export TERM=dumb
export NO_COLOR=1
if command -v locale >/dev/null 2>&1; then
  _avail=$(locale -a 2>/dev/null)
  _pick=C
  while IFS= read -r _line; do
    case "$_line" in
      C.UTF-8|C.utf8) _pick=C.UTF-8; break ;;
      en_US.UTF-8|en_US.utf8) [ "$_pick" = C ] && _pick=en_US.UTF-8 ;;
    esac
  done <<EOF
$_avail
EOF
  export LANG=$_pick; export LC_ALL=$_pick
  unset _pick _line _avail
else
  export LANG=C; export LC_ALL=C
fi
stty cols 120 rows 100 2>/dev/null
`;
  if (shell === "bash") {
    return `${common}set +o history
stty -echo 2>/dev/null
export PS1='$(echo _$?)__${sid}___]# '
`;
  }
  if (shell === "zsh") {
    return `${common}setopt PROMPT_SUBST
unset HISTFILE
stty -echo 2>/dev/null
export PS1='$(echo _$?)__${sid}___]# '
`;
  }
  return `${common}stty -echo 2>/dev/null
export PS1='__P_${sid}__> '
`;
}
