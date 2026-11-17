/** Prompts over injected writers/readers so CLI tests never touch real stdio. */

export type WriteLine = (text: string) => void;
export type ReadLine = () => Promise<string | null>;

export interface ConfirmResult {
  confirmed: boolean;
  error?: Error;
}

export async function promptConfirm(
  write: WriteLine,
  read: ReadLine,
  message: string,
  defaultYes: boolean,
): Promise<ConfirmResult> {
  write(`${message}${defaultYes ? " [Y/n]: " : " [y/N]: "}`);
  const line = await read();
  if (line === null) {
    return { confirmed: false, error: new Error("no input (EOF)") };
  }
  const answer = line.trim().toLowerCase();
  if (answer === "") return { confirmed: defaultYes };
  if (answer === "y" || answer === "yes") return { confirmed: true };
  if (answer === "n" || answer === "no") return { confirmed: false };
  return {
    confirmed: false,
    error: new Error(`invalid input ${JSON.stringify(line)}`),
  };
}
