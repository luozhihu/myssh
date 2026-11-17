/** Command-line flag parsing compatible with the Go pflag behavior we use. */

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

export interface FlagSpec {
  strings?: string[];
  numbers?: string[];
  booleans?: string[];
  arrays?: string[];
}

export interface ParsedFlags {
  strings: Map<string, string>;
  numbers: Map<string, number>;
  booleans: Set<string>;
  arrays: Map<string, string[]>;
  positionals: string[];
}

export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const strings = new Map<string, string>();
  const numbers = new Map<string, number>();
  const booleans = new Set<string>();
  const arrays = new Map<string, string[]>();
  const boolNames = new Set([...(spec.booleans ?? []), "help"]);
  const stringNames = new Set(spec.strings ?? []);
  const numberNames = new Set(spec.numbers ?? []);
  const arrayNames = new Set(spec.arrays ?? []);
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new FlagError(`unknown flag: ${arg}`);
    }
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(2, equals) : arg.slice(2);
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;

    if (boolNames.has(name)) {
      if (inline !== undefined) {
        throw new FlagError(`flag --${name} does not take a value`);
      }
      booleans.add(name);
      continue;
    }

    const known = stringNames.has(name) || numberNames.has(name) || arrayNames.has(name);
    if (!known) {
      throw new FlagError(`unknown flag: --${name}`);
    }
    let value = inline;
    if (value === undefined) {
      index += 1;
      if (index >= args.length) {
        throw new FlagError(`flag --${name} requires a value`);
      }
      value = args[index]!;
    }
    if (stringNames.has(name)) {
      strings.set(name, value);
    } else if (numberNames.has(name)) {
      if (!/^[+-]?\d+$/.test(value)) {
        throw new FlagError(`invalid value for --${name}: ${value}`);
      }
      numbers.set(name, Number(value));
    } else {
      const list = arrays.get(name) ?? [];
      list.push(value);
      arrays.set(name, list);
    }
  }
  return { strings, numbers, booleans, arrays, positionals };
}

/** Extract `--config <path>` / `--config=<path>` from positional-style args. */
export function takeConfigFlag(args: string[]): { config?: string; rest: string[] } {
  const rest: string[] = [];
  let config: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--config") {
      const value = args[index + 1];
      if (!value) throw new Error("--config requires a path");
      config = value;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
    } else {
      rest.push(arg);
    }
  }
  return { config, rest };
}
