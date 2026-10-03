/** CLI entry adapter. Commands connect to servers only when invoked. */
import * as cli from "./cli.ts";

export const loadMcpCommand = () => Promise.resolve(cli);
