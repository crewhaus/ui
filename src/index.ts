/**
 * @crewhaus/ui — drop-in web UIs for every CrewHaus harness shape.
 *
 *   import { serve } from "@crewhaus/ui";
 *   serve({ shape: "cli", harnessDir: import.meta.dir });
 *
 * `serve` boots a local server that runs your compiled bundle and renders a
 * polished, shape-aware UI for it. The scaffolding helpers back the
 * `crewhaus-ui` CLI (write a runner like the snippet above with one command).
 */
export { serve } from "../_shared/host.ts";
export type { ServeOptions } from "../_shared/host.ts";
export {
  PKG_ROOT,
  listShapes,
  readSpecTarget,
  detectShape,
  resolveHarnessDir,
  scaffold,
  type ScaffoldOptions,
} from "./scaffold.ts";
