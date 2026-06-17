/**
 * SubAgent_Loop — a loop that orchestrates child agents.
 *
 * This loop does NOT call the LLM directly. Instead it coordinates child agents:
 * - running a child agent and feeding its result to another child agent (review / verify)
 * - splitting work across multiple parallel child agents
 * - looping back to a child agent with feedback when a reviewer rejects the output
 */

export {};
