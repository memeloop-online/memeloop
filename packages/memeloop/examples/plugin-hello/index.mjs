/**
 * Example plugin-hello: adds a simple "hello" tool and a "hello-skill" to memeloop.
 *
 * Usage:
 *   1. Install: `memeloop plugin install ./examples/plugin-hello`
 *   2. Start: `memeloop start`
 *   3. The "plugin-hello.hello" tool and "hello-skill" skill will be available.
 */

/**
 * Hello tool implementation.
 * Returns a friendly greeting.
 */
function helloImpl(args) {
  const name = args?.name || "World";
  return `Hello, ${name}! Welcome to memeloop plugin marketplace.`;
}

export default {
  name: "plugin-hello",

  /**
   * Called when the plugin is loaded. Register tools, hooks, and skills.
   * @param {import("memeloop").PluginAPI} api
   */
  activate(api) {
    api.logger.info("plugin-hello v1.0.0 activated");

    // Register a simple hello tool
    api.registerTool(
      "plugin-hello.hello",
      helloImpl,
      // Optional: parameter schema (zod object)
      undefined,
    );

    // Register a hello skill (instruction injection)
    api.registerSkill({
      id: "hello-skill",
      name: "Hello Skill",
      instructions:
        "You have access to the 'plugin-hello.hello' tool. Use it to greet users who ask for a friendly hello.",
      tools: ["plugin-hello.hello"],
    });

    // Return cleanup function (optional)
    return () => {
      api.logger.info("plugin-hello deactivated");
    };
  },
};
