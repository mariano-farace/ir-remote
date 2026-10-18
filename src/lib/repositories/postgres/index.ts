/**
 * The application's repositories, resolved from one place.
 *
 * Route handlers depend on the interfaces in `src/lib/repositories/types.ts`
 * and receive instances from here, so swapping the store changes this module
 * and nothing above it. Instances are stateless wrappers around the cached
 * pool, so creating them per call is cheap and avoids a second cache to keep
 * in step with the pool during hot reload.
 */

import type { Repositories } from "@/lib/repositories/types";

import { PostgresConversationRepository } from "./conversation-repository";
import { PostgresRevisionRepository } from "./revision-repository";
import { PostgresScriptRepository } from "./script-repository";
import { PostgresStyleRepository } from "./style-repository";

export function getRepositories(): Repositories {
  return {
    scripts: new PostgresScriptRepository(),
    conversations: new PostgresConversationRepository(),
    styles: new PostgresStyleRepository(),
    revisions: new PostgresRevisionRepository(),
  };
}
