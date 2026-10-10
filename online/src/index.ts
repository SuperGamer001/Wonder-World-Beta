/**
 * Start the server.
 *
 * `listen` (@colyseus/tools) loads `.env.<NODE_ENV>`, listens on PORT (2567),
 * tells the process manager it is ready, and on Colyseus Cloud takes the
 * socket and the Redis the platform hands it. Colyseus Cloud expects this file
 * as it is; everything of ours is in app.config.ts.
 *
 * The order of the two imports matters: the first loads the environment
 * files, and config.ts (through the second) reads the environment.
 */
import { listen } from "@colyseus/tools";
import app from "./app.config.js";

listen(app);
