/** npm publishing metadata shared by Agent injection and CLI commands. */

/** The unscoped name "myssh" is taken on npm, so the package is scoped. */
export const PACKAGE_NAME = "@lxx/myssh";

/** Spec passed to `npx -y`; --pin freezes the version instead of tracking latest. */
export function packageSpec(pin: boolean, version: string): string {
  return `${PACKAGE_NAME}@${pin ? version : "latest"}`;
}

/** Registry endpoint for the latest version (scoped names encode "/" as %2F). */
export const REGISTRY_LATEST_URL =
  `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}/latest`;
