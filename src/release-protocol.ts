/** Phase A. Deploy Phase A (false) to every writer/worker first and wait for all
 * pre-A invocations to finish naturally. Never enable TTL before convergence.
 * This is a reviewed release constant, not a private configuration or secret. */
export const EMIT_MESSAGE_GENERATION = false;
